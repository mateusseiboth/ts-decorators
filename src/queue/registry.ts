/**
 * Registro de filas — cola entre os decorators @Queue e @Processor.
 *
 * @Queue registra uma fila nomeada sobre um {@link QueueAdapter}. @Processor
 * registra a função consumidora dessa fila. `startProcessors()` inicia o
 * consumo (poll do adapter) respeitando a concorrência configurada.
 *
 * Recursos de despacho:
 *  - Capacidade EXATA: um job só é marcado "processing" quando há vaga real no
 *    semáforo (tryAcquire). Assim a posição na fila (contagem de "pending") reflete
 *    o estado verdadeiro, em vez de marcar tudo como processing de uma vez.
 *  - Limite por chave (`keyOf` + `maxPerKey`): no máximo N jobs da mesma chave em voo
 *    (ex.: key = tenant). Sem `maxPerKey` o limite é 1 — a mesmo tenant nunca
 *    processa 2x em paralelo —, e tenants distintos rodam juntas. O job que excede o
 *    limite da chave permanece "pending" e NÃO ocupa vaga — liberando o slot para outra chave.
 *  - Reserva do job (`adapter.claim`): o job só roda no processo que conseguiu tirá-lo de
 *    "pending". Dois processos no mesmo armazenamento não rodam o mesmo job.
 *  - Job órfão: o job em voo renova o `lockedAt`. O "processing" que ficou sem renovar por
 *    `staleAfterMs` é de um processo que caiu, e volta para "pending".
 *  - Limite por tenant (`perTenant`): no máximo N jobs do mesmo tenant em `processing`,
 *    contados no armazenamento (vale entre processos), e a vaga livre vai primeiro para o tenant
 *    com menos jobs rodando. O adapter escolhe (`findPendingPerTenant`) e a reserva confere o
 *    limite (`claim` com `limite`); adapter sem eles escolhe pelo `findMany`.
 *  - Pausa global (`pauseProcessors`): drain mode de deploy — para de PUXAR novos
 *    jobs, mas os já em voo terminam. `getInFlightCount()` diz quando é seguro sair.
 */

import { randomUUID } from "crypto";

import { Semaphore } from "../concurrency/Semaphore";
import {
  emptyQueueStatusCounts,
  QUEUE_STATUSES,
  type QueueAdapter,
  type QueueTenantLimit,
  type QueueJob,
  type QueueStatusCounts,
} from "./adapter";
import {
  recordJobEnfileirado,
  recordJobIniciado,
  recordJobTerminado,
  type TenantDoPayload,
} from "./metrics";
import {
  buildPerTenant,
  countPerTenant,
  requirePerTenant,
  WITHOUT_TENANT,
  selectPerTenant,
  type PerTenantConfig,
  type PerTenantOptions,
} from "./perTenant";

interface ProcessorEntry {
  handler: (payload: any) => any | Promise<any>;
  concurrency: number;
  pollMs: number;
  /** Extrai a chave de serialização do payload. Mesma chave = no máx. `maxPerKey` em voo. */
  keyOf?: (payload: any) => string | number | undefined;
  /** Quantos jobs da MESMA chave podem estar em voo. Default: 1. Só vale com `keyOf`. */
  maxPerKey?: number;
  /**
   * Tempo sem renovar o `lockedAt` para o job "processing" ser dado como órfão e voltar para
   * "pending". Default: 60 s. Nunca menos que três ciclos de `pollMs`.
   */
  staleAfterMs?: number;
  /**
   * No máximo `concurrency` jobs do mesmo tenant em execução, e a vaga livre vai primeiro para a
   * tenant com menos jobs rodando. Não combina com `keyOf`.
   */
  perTenant?: PerTenantOptions;
}

/** O consumidor registrado: o `perTenant` já resolvido e o handler já embrulhado. */
interface RegisteredProcessor extends ProcessorEntry {
  perTenantConfig?: PerTenantConfig;
}

interface QueueEntry {
  name: string;
  adapter: QueueAdapter;
  processor?: RegisteredProcessor;
  running: boolean;
  timer?: ReturnType<typeof setInterval>;
  sem?: Semaphore;
  /** Quantos jobs de cada chave estão em processamento (limite por `keyOf`). */
  inFlightKeys: Map<string | number, number>;
  /** Handlers desta fila em execução agora. */
  inFlight: number;
  /** Ids dos jobs em execução NESTE processo: são os que renovam o `lockedAt`. */
  inFlightIds: Set<string>;
  /** Timer que renova o `lockedAt` dos jobs em voo. Só existe enquanto há job em voo. */
  heartbeat?: ReturnType<typeof setInterval>;
}

/** Estado de uma fila para health check: só números e flags, nunca payload. */
export interface QueueStats {
  name: string;
  hasProcessor: boolean;
  /** O consumidor está puxando jobs (o poll foi iniciado). */
  running: boolean;
  /** Drain mode global ativo: nenhuma fila puxa job novo. */
  paused: boolean;
  concurrency: number;
  inFlight: number;
  counts: QueueStatusCounts;
}

const _queues = new Map<string, QueueEntry>();

// Contador global de handlers em execução — usado pelo drain de deploy para saber
// quando não há mais trabalho em voo e é seguro encerrar o processo.
let _inFlight = 0;
// Pausa global: em drain mode paramos de puxar novos jobs (os em voo terminam).
let _paused = false;

function getOrCreate(name: string): QueueEntry {
  let entry = _queues.get(name);
  if (!entry) {
    entry = {
      name,
      adapter: undefined as any,
      running: false,
      inFlightKeys: new Map(),
      inFlight: 0,
      inFlightIds: new Set(),
    };
    _queues.set(name, entry);
  }
  return entry;
}

/** Registra (ou atualiza) o adapter de uma fila. */
export function registerQueue(name: string, adapter: QueueAdapter): void {
  getOrCreate(name).adapter = adapter;
}

const buildProcessor = (entry: ProcessorEntry): RegisteredProcessor => {
  requirePerTenant("registerProcessor", entry);
  if (!entry.perTenant) return entry;
  const perTenantConfig = buildPerTenant(entry.perTenant);
  return { ...entry, perTenantConfig };
};

/** Registra a função consumidora de uma fila. */
export function registerProcessor(name: string, entry: ProcessorEntry): void {
  getOrCreate(name).processor = buildProcessor(entry);
}

/** O tenant do job para as métricas: a `key` do `perTenant`, quando a fila tem consumidor com ele. */
const tenantOfEntry = (entry: QueueEntry): TenantDoPayload | undefined =>
  entry.processor?.perTenantConfig?.key;

/** Enfileira um payload na fila nomeada. */
export async function enqueue<T = any>(name: string, payload: T): Promise<QueueJob<T>> {
  const entry = _queues.get(name);
  if (!entry?.adapter) throw new Error(`Fila não registrada: "${name}"`);
  const job: QueueJob<T> = {
    id: randomUUID(),
    payload,
    status: "pending",
    createdAt: Date.now(),
  };
  const criado = await entry.adapter.create(job);
  recordJobEnfileirado(name, criado, tenantOfEntry(entry));
  return criado;
}

/** Devolve a vaga da chave; a chave sem job em voo sai do mapa. */
function releaseKey(entry: QueueEntry, key: string | number): void {
  const restantes = (entry.inFlightKeys.get(key) ?? 1) - 1;
  if (restantes > 0) entry.inFlightKeys.set(key, restantes);
  else entry.inFlightKeys.delete(key);
}

/** Roda o consumidor e grava a espera, a duração e o término do job. O erro segue para quem chamou. */
async function runHandlerMedido(entry: QueueEntry, job: QueueJob): Promise<void> {
  const inicio = performance.now();
  const tenantOf = tenantOfEntry(entry);
  recordJobIniciado(entry.name, job, tenantOf);
  try {
    await entry.processor!.handler(job.payload);
  } catch (err) {
    recordJobTerminado(entry.name, job, inicio, false, tenantOf);
    throw err;
  }
  recordJobTerminado(entry.name, job, inicio, true, tenantOf);
}

async function runJob(
  entry: QueueEntry,
  job: QueueJob,
  key: string | number | undefined,
  release: () => void,
): Promise<void> {
  _inFlight++;
  entry.inFlight++;
  try {
    await runHandlerMedido(entry, job);
    await entry.adapter.update(job.id, { status: "completed", lockedAt: undefined });
  } catch (err: any) {
    await entry.adapter.update(job.id, {
      status: "failed",
      error: err?.message ?? String(err),
      lockedAt: undefined,
    });
  } finally {
    _inFlight--;
    entry.inFlight--;
    entry.inFlightIds.delete(job.id);
    if (entry.inFlightIds.size === 0) stopHeartbeat(entry);
    if (key !== undefined) releaseKey(entry, key);
    release();
  }
}

const STALE_PADRAO_MS = 60_000;

/** Nunca menos que três ciclos de poll: um ciclo atrasado não pode fazer o job parecer órfão. */
const staleAfterMsOf = (processor: ProcessorEntry): number =>
  Math.max(processor.staleAfterMs ?? STALE_PADRAO_MS, processor.pollMs * 3);

/**
 * Os jobs em voo neste processo avisam que estão vivos, renovando o `lockedAt`.
 *
 * O timer é próprio, e não o do poll: `stopProcessors()` e `pauseProcessors()` param de PUXAR
 * job novo, mas o que já está rodando segue até o fim e não pode parecer órfão para outro
 * processo. Ele nasce com o primeiro job em voo e some com o último.
 */
function startHeartbeat(entry: QueueEntry): void {
  if (entry.heartbeat) return;
  const renovar = async () => {
    const agora = Date.now();
    for (const id of entry.inFlightIds) await entry.adapter.update(id, { lockedAt: agora });
  };
  entry.heartbeat = setInterval(
    () => void renovar().catch((err) => console.error(`[Queue:${entry.name}]`, err)),
    staleAfterMsOf(entry.processor!) / 3,
  );
  if ((entry.heartbeat as any).unref) (entry.heartbeat as any).unref();
}

function stopHeartbeat(entry: QueueEntry): void {
  if (entry.heartbeat) clearInterval(entry.heartbeat);
  entry.heartbeat = undefined;
}

/**
 * Devolve para "pending" o job "processing" que ninguém renova: o processo que o reservou caiu.
 * O job em voo NESTE processo nunca é órfão, mesmo que o adapter não guarde o `lockedAt`.
 */
async function requeueOrfaos(entry: QueueEntry, agora: number): Promise<void> {
  const limite = agora - staleAfterMsOf(entry.processor!);
  const emProcessamento = (await entry.adapter.findMany({ status: "processing" })) as QueueJob[];
  for (const job of emProcessamento) {
    if (entry.inFlightIds.has(job.id) || (job.lockedAt ?? 0) > limite) continue;
    await entry.adapter.update(job.id, { status: "pending", lockedAt: undefined });
  }
}

/** Reserva o job para este processo. Adapter sem `claim` grava direto, como sempre fez. */
async function claimJob(
  entry: QueueEntry,
  job: QueueJob,
  agora: number,
  limite?: QueueTenantLimit,
): Promise<boolean> {
  if (entry.adapter.claim) return entry.adapter.claim(job.id, agora, limite);
  await entry.adapter.update(job.id, { status: "processing", lockedAt: agora });
  return true;
}

/** O job reservado passa a contar como em voo neste processo e roda. */
function startJob(
  entry: QueueEntry,
  job: QueueJob,
  key: string | number | undefined,
  release: () => void,
): void {
  if (key !== undefined) entry.inFlightKeys.set(key, (entry.inFlightKeys.get(key) ?? 0) + 1);
  entry.inFlightIds.add(job.id);
  startHeartbeat(entry);
  void runJob(entry, job, key, release);
}

async function drainPorChave(entry: QueueEntry): Promise<void> {
  const agora = Date.now();
  // Drain mode: não puxa novos jobs; os já em voo seguem até terminar.
  if (_paused) return;
  await requeueOrfaos(entry, agora);
  const sem = entry.sem!;
  const keyOf = entry.processor!.keyOf;
  const maxPerKey = Math.max(1, entry.processor!.maxPerKey ?? 1);
  const pending = (await entry.adapter.findMany({ status: "pending" })) as QueueJob[];

  for (const job of pending) {
    const key = keyOf?.(job.payload);
    // A chave já está no limite dela em voo → deixa "pending" e NÃO consome vaga (o slot
    // fica livre para outra chave/tenant). Será puxado quando a chave liberar.
    const daChave = key === undefined ? 0 : (entry.inFlightKeys.get(key) ?? 0);
    if (key !== undefined && daChave >= maxPerKey) continue;

    // Capacidade exata: só marca "processing" se houver vaga real agora.
    const release = sem.tryAcquire();
    if (!release) break; // sem vaga global → nada roda neste tick.

    // Outro processo levou o job entre a leitura e a reserva: a vaga volta e o job não roda aqui.
    if (!(await claimJob(entry, job, agora))) {
      release();
      continue;
    }

    startJob(entry, job, key, release);
  }
}

/** Adapter sem `findPendingPerTenant`: a mesma escolha, sobre o `findMany`. */
async function findPendingByFindMany(
  adapter: QueueAdapter,
  config: PerTenantConfig,
  limit: number,
): Promise<QueueJob[]> {
  const withTenant = (jobs: QueueJob[]) =>
    jobs.map((job) => ({ ...job, tenant: config.tenantOf(job.payload) }));
  const pendentes = withTenant(await adapter.findMany({ status: "pending" }));
  const emProcessamento = withTenant(await adapter.findMany({ status: "processing" }));
  return selectPerTenant(pendentes, countPerTenant(emProcessamento), {
    limit,
    concurrency: config.concurrency,
  });
}

async function findPendingPerTenant(
  entry: QueueEntry,
  config: PerTenantConfig,
  limit: number,
): Promise<QueueJob[]> {
  if (!entry.adapter.findPendingPerTenant) {
    return findPendingByFindMany(entry.adapter, config, limit);
  }
  return entry.adapter.findPendingPerTenant({
    limit,
    concurrency: config.concurrency,
    tenantOf: config.tenantOf,
  });
}

const buildLimite = (tenant: string, config: PerTenantConfig): QueueTenantLimit | undefined =>
  tenant === WITHOUT_TENANT ? undefined : { tenant, concurrency: config.concurrency };

/**
 * Despacho com `perTenant`. O adapter devolve só o que cabe no limite de cada tenant, na ordem
 * justa, e a reserva confere o limite de novo no armazenamento: entre a leitura e a reserva, outro
 * processo pode ter levado a última vaga do tenant.
 */
async function drainPerTenant(entry: QueueEntry): Promise<void> {
  const agora = Date.now();
  if (_paused) return;
  await requeueOrfaos(entry, agora);
  const processor = entry.processor!;
  const config = processor.perTenantConfig!;
  const vagas = processor.concurrency - entry.inFlightIds.size;
  if (vagas <= 0) return;
  const candidatos = await findPendingPerTenant(entry, config, vagas);

  for (const job of candidatos) {
    const tenant = job.tenant ?? config.tenantOf(job.payload);
    const key = tenant === WITHOUT_TENANT ? undefined : tenant;
    // Adapter cujo `claim` não confere o limite: o deste processo ainda vale.
    if (key !== undefined && (entry.inFlightKeys.get(key) ?? 0) >= config.concurrency) continue;

    const release = entry.sem!.tryAcquire();
    if (!release) break;

    if (!(await claimJob(entry, job, agora, buildLimite(tenant, config)))) {
      release();
      continue;
    }
    startJob(entry, job, key, release);
  }
}

/** Com `perTenant`, a escolha justa por tenant; sem, a ordem de chegada com o `keyOf`. */
const drain = (entry: QueueEntry): Promise<void> =>
  entry.processor!.perTenantConfig ? drainPerTenant(entry) : drainPorChave(entry);

/** Inicia o consumo de todas as filas que têm processor registrado. */
export function startProcessors(): void {
  for (const entry of _queues.values()) {
    if (!entry.processor || !entry.adapter || entry.running) continue;
    entry.running = true;
    entry.sem = new Semaphore(entry.processor.concurrency);
    const tick = () =>
      void drain(entry).catch((err) => console.error(`[Queue:${entry.name}]`, err));
    entry.timer = setInterval(tick, entry.processor.pollMs);
    if ((entry.timer as any).unref) (entry.timer as any).unref();
    tick();
  }
}

/** Para o consumo de todas as filas (útil em testes/shutdown). */
export function stopProcessors(): void {
  for (const entry of _queues.values()) {
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = undefined;
    entry.running = false;
  }
}

/**
 * Drain mode (deploy): para de PUXAR novos jobs de todas as filas. Os que já estão
 * em voo continuam até terminar. Use com `getInFlightCount()` para saber quando é
 * seguro encerrar o processo, e `resumeProcessors()` para retomar.
 */
export function pauseProcessors(): void {
  _paused = true;
}

/** Retoma o consumo após um `pauseProcessors()`. */
export function resumeProcessors(): void {
  _paused = false;
}

/** Há consumo pausado (drain mode ativo)? */
export function isProcessingPaused(): boolean {
  return _paused;
}

/** Quantidade de handlers de fila em execução no momento (todas as filas). */
export function getInFlightCount(): number {
  return _inFlight;
}

/** Acesso ao adapter de uma fila (ex.: para inspeção/testes). */
export function getQueueAdapter(name: string): QueueAdapter | undefined {
  return _queues.get(name)?.adapter;
}

/** Nomes de todas as filas registradas (com ou sem consumidor). */
export function listQueues(): string[] {
  return [..._queues.keys()];
}

async function countsOf(adapter: QueueAdapter | undefined): Promise<QueueStatusCounts> {
  if (!adapter) return emptyQueueStatusCounts();
  if (adapter.countByStatus) return adapter.countByStatus();
  const counts = emptyQueueStatusCounts();
  for (const status of QUEUE_STATUSES) {
    counts[status] = (await adapter.findMany({ status })).length;
  }
  return counts;
}

/** Estado de cada fila registrada, para health check e monitoramento. */
export async function getQueueStats(): Promise<QueueStats[]> {
  return Promise.all(
    [..._queues.values()].map(async (entry) => ({
      name: entry.name,
      hasProcessor: !!entry.processor,
      running: entry.running,
      paused: _paused,
      concurrency: entry.processor?.concurrency ?? 0,
      inFlight: entry.inFlight,
      counts: await countsOf(entry.adapter),
    })),
  );
}

// ── Operações do painel de filas ──────────────────────────────────────────────

const LIMITE_PADRAO_DE_JOBS = 100;
const STATUS_LIMPAVEIS = new Set<QueueJob["status"]>(["completed", "failed"]);

function requireAdapter(name: string): QueueAdapter {
  const adapter = _queues.get(name)?.adapter;
  if (!adapter) throw new Error(`Fila não registrada: "${name}"`);
  return adapter;
}

async function requireJob(adapter: QueueAdapter, id: string): Promise<QueueJob> {
  const job = await adapter.findUnique(id);
  if (!job) throw new Error("Job não encontrado na fila.");
  return job;
}

/** Jobs de uma fila, os mais recentes primeiro. */
export async function getQueueJobs(
  name: string,
  options: { status?: QueueJob["status"]; limit?: number } = {},
): Promise<QueueJob[]> {
  const adapter = requireAdapter(name);
  const limit = Math.max(1, options.limit ?? LIMITE_PADRAO_DE_JOBS);
  const filter = options.status ? { status: options.status } : {};
  if (adapter.findRecent) return adapter.findRecent(filter, limit);
  const todos = await adapter.findMany(filter);
  return [...todos].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** Devolve um job com falha para a fila, sem o erro anterior. */
export async function retryQueueJob(name: string, id: string): Promise<void> {
  const adapter = requireAdapter(name);
  const job = await requireJob(adapter, id);
  if (job.status !== "failed") throw new Error("Só job com falha pode ser reprocessado.");
  await adapter.update(id, { status: "pending", error: undefined, lockedAt: undefined });
}

/** Remove um job parado. O que está em processamento termina antes. */
export async function removeQueueJob(name: string, id: string): Promise<void> {
  const adapter = requireAdapter(name);
  const job = await requireJob(adapter, id);
  if (job.status === "processing") {
    throw new Error("Job em processamento não pode ser removido.");
  }
  await adapter.delete(id);
}

/** Apaga todos os jobs concluídos (ou com falha) de uma fila; devolve quantos saíram. */
export async function purgeQueue(
  name: string,
  status: Extract<QueueJob["status"], "completed" | "failed">,
): Promise<number> {
  const adapter = requireAdapter(name);
  if (!STATUS_LIMPAVEIS.has(status)) {
    throw new Error("Só é possível limpar jobs concluídos ou com falha.");
  }
  if (adapter.deleteByStatus) return adapter.deleteByStatus(status);
  const jobs = await adapter.findMany({ status });
  for (const job of jobs) await adapter.delete(job.id);
  return jobs.length;
}

/** Limpa o registro de filas (útil em testes). */
export function clearQueues(): void {
  stopProcessors();
  for (const entry of _queues.values()) stopHeartbeat(entry);
  _queues.clear();
  _inFlight = 0;
  _paused = false;
}

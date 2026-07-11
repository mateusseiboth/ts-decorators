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
 *  - Serialização por chave (`keyOf`): no máximo UM job por chave em voo (ex.:
 *    key = entidade → a mesma entidade nunca processa 2x em paralelo, mas entidades
 *    distintas rodam juntas). Um 2º job da mesma chave permanece "pending" e NÃO
 *    ocupa vaga — liberando o slot para outra chave.
 *  - Pausa global (`pauseProcessors`): drain mode de deploy — para de PUXAR novos
 *    jobs, mas os já em voo terminam. `getInFlightCount()` diz quando é seguro sair.
 */

import {randomUUID} from "crypto";
import {Semaphore} from "../concurrency/Semaphore";
import type {QueueAdapter, QueueJob} from "./adapter";

interface ProcessorEntry {
  handler: (payload: any) => any | Promise<any>;
  concurrency: number;
  pollMs: number;
  /** Extrai a chave de serialização do payload. Mesma chave = no máx. 1 em voo. */
  keyOf?: (payload: any) => string | number | undefined;
}

interface QueueEntry {
  name: string;
  adapter: QueueAdapter;
  processor?: ProcessorEntry;
  running: boolean;
  timer?: ReturnType<typeof setInterval>;
  sem?: Semaphore;
  /** Chaves atualmente em processamento (serialização por `keyOf`). */
  inFlightKeys: Set<string | number>;
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
    entry = {name, adapter: undefined as any, running: false, inFlightKeys: new Set()};
    _queues.set(name, entry);
  }
  return entry;
}

/** Registra (ou atualiza) o adapter de uma fila. */
export function registerQueue(name: string, adapter: QueueAdapter): void {
  getOrCreate(name).adapter = adapter;
}

/** Registra a função consumidora de uma fila. */
export function registerProcessor(name: string, entry: ProcessorEntry): void {
  getOrCreate(name).processor = entry;
}

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
  return entry.adapter.create(job);
}

async function runJob(entry: QueueEntry, job: QueueJob, key: string | number | undefined, release: () => void): Promise<void> {
  _inFlight++;
  try {
    await entry.processor!.handler(job.payload);
    await entry.adapter.update(job.id, {status: "completed"});
  } catch (err: any) {
    await entry.adapter.update(job.id, {status: "failed", error: err?.message ?? String(err)});
  } finally {
    _inFlight--;
    if (key !== undefined) entry.inFlightKeys.delete(key);
    release();
  }
}

async function drain(entry: QueueEntry): Promise<void> {
  // Drain mode: não puxa novos jobs; os já em voo seguem até terminar.
  if (_paused) return;
  const sem = entry.sem!;
  const keyOf = entry.processor!.keyOf;
  const pending = (await entry.adapter.findMany({status: "pending"})) as QueueJob[];

  for (const job of pending) {
    const key = keyOf?.(job.payload);
    // Já há um job desta chave em voo → deixa "pending" e NÃO consome vaga (o slot
    // fica livre para outra chave/entidade). Será puxado quando a chave liberar.
    if (key !== undefined && entry.inFlightKeys.has(key)) continue;

    // Capacidade exata: só marca "processing" se houver vaga real agora.
    const release = sem.tryAcquire();
    if (!release) break; // sem vaga global → nada roda neste tick.

    if (key !== undefined) entry.inFlightKeys.add(key);
    await entry.adapter.update(job.id, {status: "processing"});
    void runJob(entry, job, key, release);
  }
}

/** Inicia o consumo de todas as filas que têm processor registrado. */
export function startProcessors(): void {
  for (const entry of _queues.values()) {
    if (!entry.processor || !entry.adapter || entry.running) continue;
    entry.running = true;
    entry.sem = new Semaphore(entry.processor.concurrency);
    const tick = () => void drain(entry).catch((err) => console.error(`[Queue:${entry.name}]`, err));
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

/** Limpa o registro de filas (útil em testes). */
export function clearQueues(): void {
  stopProcessors();
  _queues.clear();
  _inFlight = 0;
  _paused = false;
}

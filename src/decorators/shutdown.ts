/**
 * @OnShutdown, onShutdown e enableGracefulShutdown: desligamento organizado no SIGTERM/SIGINT.
 *
 * Ordem: para de aceitar conexões (o `server` informado), para de puxar jobs e espera os em voo,
 * para o cron e os processadores, encerra a engine de relatórios e então roda os ganchos
 * registrados, do menor `order` para o maior. Com `drainBeforeClose`, a drenagem vem antes do
 * servidor: os jobs terminam com o servidor no ar. Cada passo tem prazo; o que estourar é
 * registrado e o desligamento segue.
 *
 * O estado de drenagem (`beginDrain`, `cancelDrain`, `isDraining`, `getDrainStatus`) mora aqui
 * porque o desligamento o liga; as rotas e o middleware que o expõem ficam em `drain.ts`.
 */
import type { Server } from "node:http";

import { logger } from "../functions/logger";
import {
  getInFlightCount,
  pauseProcessors,
  resumeProcessors,
  stopProcessors,
} from "../queue/registry";
import { findReportEngine } from "../report/config";
import { readErrorMessage } from "./_errorMessage";
import {
  buildMethodName,
  createInstanceRegistry,
  makeInstanceMethodDecorator,
} from "./_instanceHooks";
import { stopAllCronJobs } from "./cron";
import { withTimeout } from "./timeout";

export interface OnShutdownOptions {
  /** Menor roda primeiro. Default: 100. */
  order?: number;
  /** Prazo do gancho, em ms. Default: 10_000. */
  timeoutMs?: number;
}

export interface ShutdownStepResult {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface RunShutdownOptions {
  /** Prazo total para os jobs em voo terminarem, em ms. Default: 25_000. */
  drainTimeoutMs?: number;
  /** Servidor HTTP que para de aceitar conexões no primeiro passo. */
  server?: Pick<Server, "close"> | { stop(closeActiveConnections?: boolean): unknown };
  /**
   * Drena as filas antes de fechar o servidor, que segue atendendo enquanto os jobs terminam.
   * Default: false (fecha o servidor primeiro).
   */
  drainBeforeClose?: boolean;
}

export interface DrainStatus {
  status: "ok" | "draining";
  draining: boolean;
  /** Jobs de fila em execução agora, em todas as filas. */
  activeJobs: number;
  /** Drenando e sem job em voo: pode encerrar o processo. */
  ready: boolean;
}

export interface GracefulShutdownOptions extends RunShutdownOptions {
  /** Default: SIGTERM e SIGINT. */
  signals?: NodeJS.Signals[];
  /** Encerra o processo ao terminar (código 0, ou 1 se algum passo falhou). Default: true. */
  exit?: boolean;
}

const SHUTDOWN_KEY = "shutdown:hooks";
const DEFAULT_ORDER = 100;
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;
/** Prazo dos passos internos sem opção própria (cron, processadores, relatórios). */
const INTERNAL_STEP_TIMEOUT_MS = 10_000;
/** A drenagem tem o próprio prazo; esta folga só protege contra um poll que trave. */
const DRAIN_GRACE_MS = 1_000;
const DRAIN_POLL_MS = 10;
const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

interface ShutdownStep {
  name: string;
  timeoutMs: number;
  run: () => unknown;
}

interface ShutdownHook extends ShutdownStep {
  order: number;
}

type ShutdownServer = NonNullable<RunShutdownOptions["server"]>;
type BunServer = { stop(closeActiveConnections?: boolean): unknown };
type NodeServer = Pick<Server, "close">;

let _hooks: ShutdownHook[] = [];
let _running: Promise<ShutdownStepResult[]> | undefined;
let _disableSignals: (() => void) | undefined;
let _draining = false;

// ── Drenagem ──────────────────────────────────────────────────────────────────────────────────

/** Para de puxar jobs; os em voo terminam. Idempotente. */
export function beginDrain(): void {
  if (_draining) return;
  _draining = true;
  pauseProcessors();
  logger.info("[Shutdown] drenagem iniciada: filas pausadas, aguardando os jobs em voo.");
}

/** Desfaz o `beginDrain` e retoma as filas. Não faz nada com o desligamento em andamento. */
export function cancelDrain(): void {
  if (!_draining || isShuttingDown()) return;
  _draining = false;
  resumeProcessors();
  logger.info("[Shutdown] drenagem cancelada: filas retomadas.");
}

export function isDraining(): boolean {
  return _draining;
}

export function getDrainStatus(): DrainStatus {
  const activeJobs = getInFlightCount();
  return {
    status: _draining ? "draining" : "ok",
    draining: _draining,
    activeJobs,
    ready: _draining && activeJobs === 0,
  };
}

// ── Ganchos ───────────────────────────────────────────────────────────────────────────────────

function addHook(name: string, fn: () => unknown, options: OnShutdownOptions = {}): () => void {
  const hook: ShutdownHook = {
    name,
    run: fn,
    order: options.order ?? DEFAULT_ORDER,
    timeoutMs: options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
  };
  _hooks.push(hook);
  return () => {
    _hooks = _hooks.filter((registrado) => registrado !== hook);
  };
}

const registry = createInstanceRegistry<OnShutdownOptions | undefined>(
  SHUTDOWN_KEY,
  (instance, { methodName, options }, invoke) =>
    addHook(buildMethodName(instance, methodName), invoke, options),
);

export function OnShutdown(options?: OnShutdownOptions): (...args: any[]) => any {
  return makeInstanceMethodDecorator("OnShutdown", registry, options);
}

/** Registra um gancho; devolve a função que o remove. */
export function onShutdown(
  name: string,
  fn: () => unknown,
  options?: OnShutdownOptions,
): () => void {
  return addHook(name, fn, options);
}

/** Registra os @OnShutdown da instância (padrão legado; o container chama sozinho). */
export function initShutdownHooks(instance: object): void {
  registry.init(instance);
}

/** Remove os @OnShutdown da instância (o container chama ao descartá-la). */
export function disposeShutdownHooks(instance: object): void {
  registry.dispose(instance);
}

// ── Passos internos ───────────────────────────────────────────────────────────────────────────

const closeNodeServer = (server: NodeServer) =>
  new Promise<void>((resolve, reject) =>
    server.close((err?: Error) => (err ? reject(err) : resolve())),
  );

/** Bun (`Bun.serve`) tem `stop()`; o `node:http` (o `app.listen` do Express) tem `close(cb)`. */
const SERVER_CLOSERS = [
  {
    matches: (server: ShutdownServer) => typeof (server as BunServer).stop === "function",
    close: (server: ShutdownServer) => (server as BunServer).stop(),
  },
  {
    matches: (server: ShutdownServer) => typeof (server as NodeServer).close === "function",
    close: (server: ShutdownServer) => closeNodeServer(server as NodeServer),
  },
] as const;

function closeServer(server: ShutdownServer): unknown {
  const closer = SERVER_CLOSERS.find((candidato) => candidato.matches(server));
  if (!closer) throw new Error("O servidor informado não tem close() nem stop().");
  return closer.close(server);
}

/** Para de puxar jobs e espera os em voo, até o prazo. */
async function drainQueues(drainTimeoutMs: number): Promise<void> {
  beginDrain();
  const limite = Date.now() + drainTimeoutMs;
  // `Bun.sleep` segura o processo: a drenagem não pode ser cortada porque o laço ficou vazio.
  while (getInFlightCount() > 0 && Date.now() < limite) await Bun.sleep(DRAIN_POLL_MS);
  const restantes = getInFlightCount();
  if (restantes > 0) {
    throw new Error(`${restantes} job(s) ainda em andamento após ${drainTimeoutMs} ms.`);
  }
}

function stopWorkers(): void {
  stopProcessors();
  stopAllCronJobs();
}

const buildServerSteps = (options: RunShutdownOptions, drainTimeoutMs: number): ShutdownStep[] => {
  const { server } = options;
  if (!server) return [];
  return [{ name: "servidor", timeoutMs: drainTimeoutMs, run: () => closeServer(server) }];
};

const buildReportSteps = (): ShutdownStep[] => {
  const engine = findReportEngine();
  if (!engine) return [];
  return [
    { name: "relatórios", timeoutMs: INTERNAL_STEP_TIMEOUT_MS, run: () => engine.shutdown() },
  ];
};

/** O gancho de mesmo `order` mantém a ordem de registro (o `sort` é estável). */
const buildHookSteps = (): ShutdownStep[] => [..._hooks].sort((a, b) => a.order - b.order);

const buildDrainStep = (drainTimeoutMs: number): ShutdownStep => ({
  name: "drenagem das filas",
  timeoutMs: drainTimeoutMs + DRAIN_GRACE_MS,
  run: () => drainQueues(drainTimeoutMs),
});

/** Servidor e drenagem, na ordem pedida: `drainBeforeClose` drena com o servidor ainda no ar. */
const buildOpeningSteps = (options: RunShutdownOptions, drainTimeoutMs: number): ShutdownStep[] => {
  const server = buildServerSteps(options, drainTimeoutMs);
  const drain = buildDrainStep(drainTimeoutMs);
  return options.drainBeforeClose ? [drain, ...server] : [...server, drain];
};

function buildSteps(options: RunShutdownOptions): ShutdownStep[] {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  return [
    ...buildOpeningSteps(options, drainTimeoutMs),
    { name: "cron e processadores", timeoutMs: INTERNAL_STEP_TIMEOUT_MS, run: stopWorkers },
    ...buildReportSteps(),
    ...buildHookSteps(),
  ];
}

// ── Sequência ─────────────────────────────────────────────────────────────────────────────────

async function runStep(step: ShutdownStep): Promise<ShutdownStepResult> {
  const inicio = performance.now();
  const readDuration = () => Math.round(performance.now() - inicio);
  try {
    await withTimeout(() => step.run(), step.timeoutMs, step.name);
    logger.info(`[Shutdown] ${step.name}: concluído.`);
    return { name: step.name, ok: true, durationMs: readDuration() };
  } catch (err) {
    const error = readErrorMessage(err);
    logger.error(`[Shutdown] ${step.name}: ${error}`);
    return { name: step.name, ok: false, durationMs: readDuration(), error };
  }
}

/** Um passo por vez: o erro ou o prazo estourado de um não interrompe os seguintes. */
async function runSequence(options: RunShutdownOptions): Promise<ShutdownStepResult[]> {
  const results: ShutdownStepResult[] = [];
  for (const step of buildSteps(options)) results.push(await runStep(step));
  return results;
}

/** Roda o desligamento uma vez (chamadas seguintes devolvem o mesmo resultado). */
export function runShutdown(options: RunShutdownOptions = {}): Promise<ShutdownStepResult[]> {
  _running ??= runSequence(options);
  return _running;
}

export function isShuttingDown(): boolean {
  return _running !== undefined;
}

// ── Sinais ────────────────────────────────────────────────────────────────────────────────────

const buildExitCode = (results: ShutdownStepResult[]) => (results.some((r) => !r.ok) ? 1 : 0);

/** Sinal repetido durante o desligamento: quem mandou quer o processo fora agora. */
function forceExit(signal: NodeJS.Signals, options: GracefulShutdownOptions): void {
  logger.warn(`[Shutdown] ${signal} durante o desligamento: saída forçada.`);
  if (options.exit === false) return;
  process.exit(1);
}

async function handleSignal(
  signal: NodeJS.Signals,
  options: GracefulShutdownOptions,
): Promise<void> {
  if (isShuttingDown()) return forceExit(signal, options);
  logger.info(`[Shutdown] ${signal} recebido: desligando.`);
  const results = await runShutdown(options);
  if (options.exit === false) return;
  process.exit(buildExitCode(results));
}

/** Liga os sinais; devolve a função que desliga a escuta. */
export function enableGracefulShutdown(options: GracefulShutdownOptions = {}): () => void {
  if (_disableSignals) return _disableSignals;
  // `on`, e não `once`: o segundo sinal precisa chegar aqui para forçar a saída.
  const listeners = (options.signals ?? DEFAULT_SIGNALS).map(
    (signal) => [signal, () => void handleSignal(signal, options)] as const,
  );
  for (const [signal, listener] of listeners) process.on(signal, listener);

  const disable = () => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
    if (_disableSignals === disable) _disableSignals = undefined;
  };
  _disableSignals = disable;
  return disable;
}

/** Esquece ganchos, estado do desligamento e da drenagem (testes). */
export function resetShutdown(): void {
  _hooks = [];
  _running = undefined;
  _draining = false;
  _disableSignals?.();
  registry.reset();
}

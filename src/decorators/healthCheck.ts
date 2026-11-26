/**
 * @HealthCheck, registerHealthCheck e createHealthRouter: sondas de saúde e as rotas `/health`
 * (o processo está vivo) e `/ready` (as dependências respondem e o app não está desligando nem
 * drenando).
 */
import { Router } from "express";

import { readErrorMessage } from "./_errorMessage";
import {
  buildMethodName,
  createInstanceRegistry,
  makeInstanceMethodDecorator,
} from "./_instanceHooks";
import { isDraining, isShuttingDown } from "./shutdown";
import { withTimeout } from "./timeout";

export type HealthStatus = "up" | "down";

export interface HealthCheckOptions {
  /** Default: `Classe.metodo`. */
  name?: string;
  /** Sonda crítica derruba o `/ready`; a não crítica só aparece no relatório. Default: true. */
  critical?: boolean;
  /** Prazo da sonda, em ms. Default: 3_000. */
  timeoutMs?: number;
}

export interface HealthCheckResult {
  name: string;
  status: HealthStatus;
  critical: boolean;
  durationMs: number;
  error?: string;
  /** O que a sonda devolveu, quando é um objeto. */
  details?: unknown;
}

export interface HealthReport {
  status: HealthStatus;
  checks: HealthCheckResult[];
}

export interface HealthRouterOptions {
  /** Default: "/health". */
  livePath?: string;
  /** Default: "/ready". */
  readyPath?: string;
}

const HEALTH_KEY = "health:checks";
const DEFAULT_TIMEOUT_MS = 3_000;
const HTTP_STATUS: Record<HealthStatus, number> = { up: 200, down: 503 };

interface RegisteredCheck {
  name: string;
  check: () => unknown;
  critical: boolean;
  timeoutMs: number;
}

let _checks: RegisteredCheck[] = [];
/** O último resultado de cada sonda, do último `runHealthChecks` (o gauge `app.health.check`). */
const _ultimos = new Map<string, HealthStatus>();

// ── Registro ──────────────────────────────────────────────────────────────────────────────────

/** Registra uma sonda; devolve a função que a remove. */
export function registerHealthCheck(
  name: string,
  check: () => unknown,
  options: Omit<HealthCheckOptions, "name"> = {},
): () => void {
  const registrada: RegisteredCheck = {
    name,
    check,
    critical: options.critical ?? true,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  _checks.push(registrada);
  return () => {
    _checks = _checks.filter((atual) => atual !== registrada);
    _ultimos.delete(name);
  };
}

const registry = createInstanceRegistry<HealthCheckOptions | undefined>(
  HEALTH_KEY,
  (instance, { methodName, options }, invoke) =>
    registerHealthCheck(options?.name ?? buildMethodName(instance, methodName), invoke, options),
);

export function HealthCheck(options?: HealthCheckOptions): (...args: any[]) => any {
  return makeInstanceMethodDecorator("HealthCheck", registry, options);
}

/** Registra os @HealthCheck da instância (padrão legado; o container chama sozinho). */
export function initHealthChecks(instance: object): void {
  registry.init(instance);
}

/** Remove as sondas da instância (o container chama ao descartá-la). */
export function disposeHealthChecks(instance: object): void {
  registry.dispose(instance);
}

export function clearHealthChecks(): void {
  _checks = [];
  _ultimos.clear();
  registry.reset();
}

// ── Execução ──────────────────────────────────────────────────────────────────────────────────

const isDetails = (value: unknown): value is object => typeof value === "object" && value !== null;

async function runCheck(registrada: RegisteredCheck): Promise<HealthCheckResult> {
  const { name, critical, timeoutMs } = registrada;
  const inicio = performance.now();
  const readDuration = () => Math.round(performance.now() - inicio);
  try {
    const value = await withTimeout(() => registrada.check(), timeoutMs, name);
    if (value === false) throw new Error("A sonda respondeu false.");
    const details = isDetails(value) ? { details: value } : {};
    return { name, status: "up", critical, durationMs: readDuration(), ...details };
  } catch (err) {
    const error = readErrorMessage(err);
    return { name, status: "down", critical, durationMs: readDuration(), error };
  }
}

const isCriticalDown = (result: HealthCheckResult) => result.critical && result.status === "down";

/** Roda as sondas em paralelo. O relatório cai se alguma sonda crítica cair. */
export async function runHealthChecks(): Promise<HealthReport> {
  const checks = await Promise.all(_checks.map(runCheck));
  for (const { name, status } of checks) _ultimos.set(name, status);
  return { status: checks.some(isCriticalDown) ? "down" : "up", checks };
}

/**
 * O último resultado de cada sonda. O gauge lê daqui, sem rodar as sondas de novo: quem roda é o
 * `/ready` (ou o `runHealthChecks` do app), no ritmo do orquestrador.
 */
export function getLastHealthResults(): ReadonlyMap<string, HealthStatus> {
  return _ultimos;
}

// ── Rotas ─────────────────────────────────────────────────────────────────────────────────────

const isLeavingBalancer = () => isShuttingDown() || isDraining();

export function createHealthRouter(options: HealthRouterOptions = {}): Router {
  const router = Router();

  // Liveness: o processo responde, inclusive durante o desligamento.
  router.get(options.livePath ?? "/health", (_req, res) => {
    res.json({ status: "up" });
  });

  // Readiness: desligando ou drenando, sai do balanceador sem gastar tempo com as sondas.
  router.get(options.readyPath ?? "/ready", async (_req, res) => {
    if (isLeavingBalancer()) {
      res
        .status(503)
        .json({ status: "down", shuttingDown: isShuttingDown(), draining: isDraining() });
      return;
    }
    const report = await runHealthChecks();
    res.status(HTTP_STATUS[report.status]).json(report);
  });

  return router;
}

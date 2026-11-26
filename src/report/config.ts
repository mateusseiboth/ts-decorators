import { ReportEngine } from "./ReportEngine";
import type { ReportEngineOptions, ReportOutputStrategy } from "./types";

let _engine: ReportEngine | undefined;

/**
 * Setter de boot da engine de relatórios (estilo setPrismaClient): o app chama
 * UMA vez no bootstrap com seus pontos de acoplamento. Idempotente: reconfigurar
 * substitui a instância (a anterior é encerrada de forma assíncrona).
 */
export function configureReportEngine(options: ReportEngineOptions): ReportEngine {
  if (_engine) void _engine.shutdown().catch(() => undefined);
  _engine = new ReportEngine(options);
  return _engine;
}

export function getReportEngine(): ReportEngine {
  if (!_engine) {
    throw new Error("Report engine não configurada. Chame configureReportEngine() no boot do app.");
  }
  return _engine;
}

/** A engine configurada, ou `undefined` se o app não usa relatórios (desligamento). */
export function findReportEngine(): ReportEngine | undefined {
  return _engine;
}

/** Desfaz a configuração (testes). */
export async function resetReportEngine(): Promise<void> {
  const engine = _engine;
  _engine = undefined;
  await engine?.shutdown().catch(() => undefined);
}

/** Registra um formato extra (ex.: XLSX) na engine configurada. */
export function registerOutputFormat(strategy: ReportOutputStrategy): void {
  getReportEngine().formats.register(strategy);
}

export function getOutputFormat(format: string): ReportOutputStrategy {
  return getReportEngine().formats.get(format);
}

export function listOutputFormats(): string[] {
  return getReportEngine().formats.list();
}

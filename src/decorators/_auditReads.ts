/**
 * Lote das leituras auditadas pelo `@Auditable({ read })`, gravado na tabela `audit_log`.
 *
 * A leitura não usa a transação da requisição: muitas vezes não existe, e quando existe pode sofrer
 * rollback depois que o dado já saiu na resposta. O registro de que alguém viu o dado não pode sumir
 * junto. Por isso o lote abre a PRÓPRIA transação pelo client do `setPrismaClient`.
 *
 * Leitura é frequente: um INSERT por leitura dobraria as idas ao banco do caminho mais quente da
 * aplicação. As entradas esperam na memória e vão num INSERT só, a cada `FLUSH_INTERVAL_MS` ou
 * quando o lote chega a `MAX_BATCH`. Uma transação por entidade, para a função do
 * `setTransactionalCompanyFn` (RLS) valer em cada uma.
 */
import { logger } from "../functions/logger";
import { findPrismaClient, runInTransaction } from "../handlers/prisma";
import { runStatement } from "../prisma8/client";
import { buildAuditInsert } from "./_auditLogSql";
import type { AuditEntry } from "./auditable";
import { findTransactionalCompanyFn } from "./transactional";

const FLUSH_INTERVAL_MS = 1_000;
const MAX_BATCH = 100;

let _buffer: AuditEntry[] = [];
let _timer: ReturnType<typeof setTimeout> | null = null;
let _hasExitHook = false;
let _hasWarnedWithoutClient = false;

function groupByTenant(entries: readonly AuditEntry[]): Map<number, AuditEntry[]> {
  const grupos = new Map<number, AuditEntry[]>();
  for (const entry of entries) {
    grupos.set(entry.entidade, [...(grupos.get(entry.entidade) ?? []), entry]);
  }
  return grupos;
}

async function saveGrupo(entidade: number, entries: AuditEntry[]): Promise<void> {
  const client = findPrismaClient()!;
  const addCompany = findTransactionalCompanyFn();
  await runInTransaction(client, async (tx) => {
    if (addCompany && entidade) await addCompany(tx, String(entidade));
    await runStatement(tx, buildAuditInsert(entries));
  });
}

function warnWithoutClient(total: number): void {
  if (_hasWarnedWithoutClient) return;
  _hasWarnedWithoutClient = true;
  logger.warn(
    `[@mateusseiboth/ts-decorators] Auditable: ${total} leitura(s) sem destino. Chame setPrismaClient() no bootstrap ou defina um setAuditStorage().`,
  );
}

function clearTimer(): void {
  if (_timer) clearTimeout(_timer);
  _timer = null;
}

/**
 * Grava agora as leituras que estão esperando. Nunca lança: a falha vai para o logger. Chame no
 * desligamento (`onShutdown`) para não perder o último lote.
 */
export async function flushAuditReads(): Promise<void> {
  clearTimer();
  const entries = _buffer;
  _buffer = [];
  if (!entries.length) return;
  if (!findPrismaClient()) return warnWithoutClient(entries.length);

  const gravacoes = [...groupByTenant(entries)].map(([entidade, grupo]) =>
    saveGrupo(entidade, grupo).catch((err) =>
      logger.error(
        "[@mateusseiboth/ts-decorators] Auditable: Erro ao gravar leituras no audit_log:",
        err,
      ),
    ),
  );
  await Promise.all(gravacoes);
}

function scheduleFlush(): void {
  if (_timer) return;
  _timer = setTimeout(() => void flushAuditReads(), FLUSH_INTERVAL_MS);
  // Leitura pendente não segura o processo de pé; o `beforeExit` grava o que sobrou.
  _timer.unref?.();
}

function registerExitHook(): void {
  if (_hasExitHook) return;
  _hasExitHook = true;
  process.on("beforeExit", () => void flushAuditReads());
}

/** Põe a leitura no lote. Não espera o banco. */
export function enqueueAuditRead(entry: AuditEntry): void {
  registerExitHook();
  _buffer.push(entry);
  if (_buffer.length >= MAX_BATCH) {
    void flushAuditReads();
    return;
  }
  scheduleFlush();
}

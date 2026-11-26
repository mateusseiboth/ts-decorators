/**
 * @AdvisoryLock e withAdvisoryLock: trava no BANCO, que vale entre instâncias da aplicação (o
 * `@Mutex` e o `@Semaphore` valem só dentro do processo).
 *
 * - Postgres: `pg_advisory_xact_lock`, pelo Prisma 7 ou 8. A trava é da TRANSAÇÃO: o banco solta
 *   sozinho no commit ou no rollback, então quem chega depois já enxerga o que foi gravado.
 * - MySQL: `GET_LOCK`/`RELEASE_LOCK`, pelo Prisma 7 (no pacote, o Prisma 8 é só Postgres). A trava
 *   é da CONEXÃO: é solta no fim da função, antes do commit.
 *
 * Sempre dentro de uma transação aberta: fora dela, cada comando pode cair numa conexão diferente
 * do pool e a trava não protege nada.
 *
 * A chave nunca entra no SQL. Vira um hash de 64 bits (número no Postgres, `qs_<hex>` no MySQL).
 *
 * A espera pela trava (não a função) vai para o histograma `app.advisory_lock.wait.duration`, com
 * `outcome` adquirido, timeout ou erro. A chave não entra na métrica.
 */
import { findTransaction } from "../handlers/context";
import { METRICA } from "../observability/catalog";
import { recordMetric } from "../observability/metrics";
import { isPrisma7Tx, isPrisma8Tx, runStatement } from "../prisma8/client";
import { makeMethodDecorator } from "./_method";

export type AdvisoryLockDialect = "postgres" | "mysql";

export interface AdvisoryLockOptions {
  /** Chave da trava, fixa ou a partir dos argumentos da chamada. */
  key: string | ((...args: any[]) => string);
  /** Espera máxima pela trava, em ms. Sem ela, espera o quanto for preciso. */
  waitMs?: number;
  /** Default: o de `configureAdvisoryLock` ("postgres"). */
  dialect?: AdvisoryLockDialect;
  /** Onde achar a transação. Default: contexto do handler, `this.DAO.tx` ou `this.tx`. */
  tx?: (instance: any) => unknown;
}

export interface WithAdvisoryLockOptions {
  waitMs?: number;
  dialect?: AdvisoryLockDialect;
}

export class AdvisoryLockTimeoutError extends Error {
  constructor(
    readonly key: string,
    readonly waitMs: number,
  ) {
    super(`A trava ${key} não foi liberada em ${waitMs} ms.`);
    this.name = "AdvisoryLockTimeoutError";
  }
}

let _dialect: AdvisoryLockDialect = "postgres";

export function configureAdvisoryLock(options: { dialect: AdvisoryLockDialect }): void {
  _dialect = options.dialect;
}

// ── Hash da chave ─────────────────────────────────────────────────────────────────────────

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** FNV-1a de 64 bits sobre o UTF-8 da chave. */
function hashKey(key: string): bigint {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(key)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV_PRIME);
  }
  return hash;
}

// ── Dialetos ──────────────────────────────────────────────────────────────────────────────

interface LockRequest<T> {
  tx: unknown;
  key: string;
  hash: bigint;
  waitMs?: number;
  fn: () => T | Promise<T>;
}

type DialectRunner = <T>(request: LockRequest<T>) => Promise<T>;

const isLockTimeout = (error: unknown) =>
  /lock timeout/i.test((error as Error | undefined)?.message ?? "") ||
  (error as { code?: string } | undefined)?.code === "55P03";

async function lockPostgres(tx: unknown, id: bigint, key: string, waitMs?: number) {
  try {
    await runStatement(tx, `SELECT pg_advisory_xact_lock(${id})`);
  } catch (error) {
    if (waitMs !== undefined && isLockTimeout(error))
      throw new AdvisoryLockTimeoutError(key, waitMs);
    throw error;
  }
}

// ── Espera pela trava ─────────────────────────────────────────────────────────────────────

const OUTCOME_DA_TRAVA = { ADQUIRIDO: "adquirido", TIMEOUT: "timeout", ERRO: "erro" } as const;

const readOutcomeDaFalha = (error: unknown) =>
  error instanceof AdvisoryLockTimeoutError ? OUTCOME_DA_TRAVA.TIMEOUT : OUTCOME_DA_TRAVA.ERRO;

/** Mede a espera pela trava; a falha é relançada como veio. */
async function measureEspera(acquire: () => Promise<void>): Promise<void> {
  const inicio = performance.now();
  const record = (outcome: string) =>
    recordMetric({
      ...METRICA.ADVISORY_LOCK_WAIT,
      value: (performance.now() - inicio) / 1000,
      attributes: { outcome },
    });
  try {
    await acquire();
  } catch (error) {
    record(readOutcomeDaFalha(error));
    throw error;
  }
  record(OUTCOME_DA_TRAVA.ADQUIRIDO);
}

async function acquirePostgres(tx: unknown, id: bigint, key: string, waitMs?: number) {
  if (waitMs === undefined) return lockPostgres(tx, id, key);
  await runStatement(tx, `SET LOCAL lock_timeout = '${Math.max(0, Math.round(waitMs))}ms'`);
  await lockPostgres(tx, id, key, waitMs);
  await runStatement(tx, "SET LOCAL lock_timeout TO DEFAULT");
}

const runPostgres: DialectRunner = async ({ tx, key, hash, waitMs, fn }) => {
  await measureEspera(() => acquirePostgres(tx, BigInt.asIntN(64, hash), key, waitMs));
  return fn();
};

type QueryRaw = (sql: string) => Promise<Record<string, unknown>[]>;

function requireQueryRaw(tx: unknown): QueryRaw {
  const query = (tx as { $queryRawUnsafe?: QueryRaw } | undefined)?.$queryRawUnsafe;
  if (!isPrisma7Tx(tx) || typeof query !== "function") {
    throw new Error(
      "[@mateusseiboth/ts-decorators] No MySQL, o @AdvisoryLock precisa de uma transação do Prisma 7.",
    );
  }
  return query.bind(tx);
}

/** `GET_LOCK` aceita segundos; -1 espera sem limite. */
const toMySqlSeconds = (waitMs?: number) =>
  waitMs === undefined ? -1 : Math.max(0, Math.ceil(waitMs / 1000));

/** `GET_LOCK` devolve 1 (travou), 0 (tempo esgotado) ou NULL (erro), como number ou bigint. */
const GET_LOCK_RESULTS: Record<string, (key: string, waitMs: number) => void> = {
  "1": () => undefined,
  "0": (key, waitMs) => {
    throw new AdvisoryLockTimeoutError(key, waitMs);
  },
};

async function acquireMySql(query: QueryRaw, name: string, key: string, waitMs?: number) {
  const [row] = await query(`SELECT GET_LOCK('${name}', ${toMySqlSeconds(waitMs)}) AS travou`);
  const result = GET_LOCK_RESULTS[String(row?.travou)];
  if (!result)
    throw new Error(`[@mateusseiboth/ts-decorators] O GET_LOCK da trava ${key} falhou no banco.`);
  result(key, waitMs ?? -1);
}

const runMySql: DialectRunner = async ({ tx, key, hash, waitMs, fn }) => {
  const query = requireQueryRaw(tx);
  const name = `qs_${hash.toString(16).padStart(16, "0")}`;
  await measureEspera(() => acquireMySql(query, name, key, waitMs));
  try {
    return await fn();
  } finally {
    await query(`SELECT RELEASE_LOCK('${name}') AS liberou`);
  }
};

const DIALECTS: Record<AdvisoryLockDialect, DialectRunner> = {
  postgres: runPostgres,
  mysql: runMySql,
};

// ── Entrada ───────────────────────────────────────────────────────────────────────────────

const isTransaction = (tx: unknown) => isPrisma7Tx(tx) || isPrisma8Tx(tx);

export async function withAdvisoryLock<T>(
  tx: unknown,
  key: string,
  fn: () => T | Promise<T>,
  options: WithAdvisoryLockOptions = {},
): Promise<T> {
  if (!isTransaction(tx)) {
    throw new Error(
      "[@mateusseiboth/ts-decorators] O @AdvisoryLock precisa de uma transação aberta do Prisma.",
    );
  }
  if (!key.trim())
    throw new Error("[@mateusseiboth/ts-decorators] Informe a chave do @AdvisoryLock.");
  const run = DIALECTS[options.dialect ?? _dialect];
  return run({ tx, key, hash: hashKey(key), waitMs: options.waitMs, fn });
}

export function AdvisoryLock(options: AdvisoryLockOptions) {
  const readKey = typeof options.key === "function" ? options.key : () => options.key as string;
  const readTx = options.tx ?? findTransaction;
  return makeMethodDecorator("AdvisoryLock", (original) => {
    return function (this: any, ...args: any[]) {
      return withAdvisoryLock(readTx(this), readKey(...args), () => original.apply(this, args), {
        waitMs: options.waitMs,
        dialect: options.dialect,
      });
    };
  });
}

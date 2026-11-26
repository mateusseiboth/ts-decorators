/**
 * Métricas do banco pelo mecanismo nativo do Prisma 8: um middleware do runtime SQL
 * (`SqlMiddleware`, de `@prisma/orm-postgres/family-runtime`). O runtime trata cada statement e
 * cada transação como uma ATIVIDADE e avisa o middleware quando ela começa
 * (`activityStarted`), termina (`activityEnded`) e quando os efeitos dela ficam definitivos
 * (`activityFinalized`).
 *
 * - `db.client.operation.duration`: cada statement, com a latência que o próprio runtime mediu,
 *   a tabela (`db.collection.name`, lida do AST), a operação (`SELECT`, `INSERT`, `UPDATE`,
 *   `DELETE`, `RAW`) e o desfecho (`ok`/`erro`). A resposta que um middleware de cache deu no
 *   lugar do banco não entra.
 * - `db.client.transaction.duration`: da abertura ao desfecho final (`commit`, `rollback` ou
 *   `desconhecido`, quando o runtime não sabe se gravou).
 *
 * O pacote não importa o Prisma 8: as atividades são lidas pela forma, e o objeto devolvido entra
 * no `middleware: [...]` do `postgres({ ... })` do projeto.
 *
 * Uso (db.ts do projeto):
 *   export const db = postgres({ contract, url, middleware: [createPrisma8Metrics()] });
 */

import { logger } from "../functions/logger";
import { METRICA, toOutcome } from "./catalog";
import { recordMetric, type MetricAttributes } from "./metrics";

/** Uma atividade do runtime, no que a métrica lê. */
export interface Prisma8ActivityLike {
  readonly kind: string;
  readonly plan?: unknown;
}

/** O fim de uma atividade (`activityEnded`). */
export interface Prisma8ActivityEndedLike {
  readonly kind: string;
  readonly outcome: string;
  /** Só no statement. */
  readonly latencyMs?: number;
  /** Só no statement: `middleware` quando um `intercept` respondeu no lugar do banco. */
  readonly source?: string;
}

/** O desfecho definitivo de uma atividade (`activityFinalized`). */
export interface Prisma8ActivityFinalizedLike {
  readonly outcome: string;
}

/** O contexto da atividade, no que a métrica lê: o relógio do runtime, em ms. */
export interface Prisma8ActivityContextLike {
  now(): number;
}

/** O middleware de métricas, na forma do `SqlMiddleware` do Prisma 8. */
export interface Prisma8MetricsMiddleware {
  readonly name: string;
  readonly familyId: "sql";
  activityStarted(activity: Prisma8ActivityLike, ctx: Prisma8ActivityContextLike): Promise<void>;
  activityEnded(
    activity: Prisma8ActivityLike,
    result: Prisma8ActivityEndedLike,
    ctx: Prisma8ActivityContextLike,
  ): Promise<void>;
  activityFinalized(
    activity: Prisma8ActivityLike,
    result: Prisma8ActivityFinalizedLike,
    ctx: Prisma8ActivityContextLike,
  ): Promise<void>;
}

const NOME_DO_MIDDLEWARE = "@mateusseiboth/ts-decorators/metricas";

// ── Statement ─────────────────────────────────────────────────────────────────────────────────

interface AstLike {
  kind?: string;
  from?: { kind?: string; name?: string };
  table?: { kind?: string; name?: string };
}

/** A operação de cada nó raiz do AST do Prisma 8 (`AnyQueryAst`). */
const OPERACOES: Record<string, string> = {
  select: "SELECT",
  insert: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
  "raw-query": "RAW",
};

/** A tabela do statement: o `FROM` do SELECT, ou a tabela do INSERT, UPDATE e DELETE. */
const readTabela = (ast: AstLike): string | undefined => {
  const origem = ast.from ?? ast.table;
  return origem?.kind === "table-source" ? origem.name : undefined;
};

const buildAtributosDoStatement = (plan: unknown): MetricAttributes => {
  const ast = ((plan as { ast?: AstLike } | undefined)?.ast ?? {}) as AstLike;
  const tabela = readTabela(ast);
  const operacao = OPERACOES[ast.kind ?? ""];
  return {
    ...(tabela === undefined ? {} : { "db.collection.name": tabela }),
    ...(operacao === undefined ? {} : { "db.operation.name": operacao }),
  };
};

const isIdaAoBanco = (result: Prisma8ActivityEndedLike): boolean =>
  result.kind === "statement" && result.source !== "middleware";

const recordStatement = (activity: Prisma8ActivityLike, result: Prisma8ActivityEndedLike) =>
  recordMetric({
    ...METRICA.DB_OPERATION,
    value: (result.latencyMs ?? 0) / 1000,
    attributes: {
      ...buildAtributosDoStatement(activity.plan),
      outcome: toOutcome(result.outcome !== "failed"),
    },
  });

// ── Transação ─────────────────────────────────────────────────────────────────────────────────

const DESFECHO_DA_TRANSACAO: Record<string, string> = {
  committed: "commit",
  "rolled-back": "rollback",
};

const isTransacao = (activity: Prisma8ActivityLike): boolean => activity.kind === "transaction";

/**
 * Quem observa não pode derrubar a consulta: erro lançado em `activityEnded` de uma atividade que
 * deu certo faria ela falhar.
 */
const runSeguro = (run: () => void): Promise<void> => {
  try {
    run();
  } catch (err) {
    logger.error("[@mateusseiboth/ts-decorators] Métricas do Prisma 8:", err);
  }
  return Promise.resolve();
};

/** O middleware do runtime do Prisma 8 que grava as métricas do banco. */
export function createPrisma8Metrics(): Prisma8MetricsMiddleware {
  // O início de cada transação aberta. A chave é a própria atividade: some com ela.
  const inicios = new WeakMap<object, number>();

  return {
    name: NOME_DO_MIDDLEWARE,
    familyId: "sql",
    activityStarted: (activity, ctx) =>
      runSeguro(() => {
        if (isTransacao(activity)) inicios.set(activity, ctx.now());
      }),
    activityEnded: (activity, result) =>
      runSeguro(() => {
        if (isIdaAoBanco(result)) recordStatement(activity, result);
      }),
    activityFinalized: (activity, result, ctx) =>
      runSeguro(() => {
        const inicio = inicios.get(activity);
        if (!isTransacao(activity) || inicio === undefined) return;
        inicios.delete(activity);
        recordMetric({
          ...METRICA.DB_TRANSACTION,
          value: (ctx.now() - inicio) / 1000,
          attributes: { outcome: DESFECHO_DA_TRANSACAO[result.outcome] ?? "desconhecido" },
        });
      }),
  };
}

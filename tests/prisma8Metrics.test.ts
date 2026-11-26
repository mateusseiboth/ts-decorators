/**
 * O middleware de métricas do Prisma 8 recebe as atividades do runtime (`activityStarted`,
 * `activityEnded`, `activityFinalized`). As atividades aqui têm a forma dos tipos do
 * `@prisma/orm-framework/components/runtime` (8.0.0-rc.21): o pacote não depende do Prisma 8.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { BUCKETS_DB } from "../src/observability/buckets";
import { createPrisma8Metrics } from "../src/observability/prisma8Metrics";
import { startColetor, type Coletor } from "./_metricas";

let agora = 1_000;
const fakeCtx = () => ({ now: () => agora });

const statement = (ast: unknown) => ({
  id: crypto.randomUUID(),
  kind: "statement" as const,
  returns: "rows" as const,
  annotations: new Map(),
  plan: { sql: "...", params: [], ast, meta: { lane: "orm" } },
});

const tabela = (name: string) => ({ kind: "table-source", name });

const terminou = (outcome: string, latencyMs: number, source = "driver") => ({
  kind: "statement" as const,
  outcome,
  latencyMs,
  source,
  returns: "rows" as const,
  rowCount: 1,
});

describe("createPrisma8Metrics", () => {
  let coletor: Coletor;

  beforeEach(() => {
    coletor = startColetor();
  });
  afterEach(() => coletor.stop());

  test("é um middleware SQL com nome", () => {
    const middleware = createPrisma8Metrics();
    expect(middleware.familyId).toBe("sql");
    expect(middleware.name).toBe("@mateusseiboth/ts-decorators/metricas");
  });

  test("statement: a tabela, a operação e o desfecho, em segundos", async () => {
    const middleware = createPrisma8Metrics();
    const ctx = fakeCtx();
    const casos = [
      [{ kind: "select", from: tabela("imovel") }, "succeeded", 12],
      [{ kind: "insert", table: tabela("parcela") }, "succeeded", 3],
      [{ kind: "update", table: tabela("parcela") }, "failed", 5],
      [{ kind: "delete", table: tabela("imovel") }, "stopped", 2],
    ] as const;
    for (const [ast, outcome, latencyMs] of casos) {
      const atividade = statement(ast);
      await middleware.activityStarted(atividade, ctx);
      await middleware.activityEnded(atividade, terminou(outcome, latencyMs), ctx);
    }

    const metrica = await coletor.find("db.client.operation.duration");
    expect(metrica?.descriptor.unit).toBe("s");
    const pontos = await coletor.histogram("db.client.operation.duration");
    expect(pontos.map(({ attributes, sum }) => ({ attributes, sum }))).toEqual([
      {
        attributes: {
          "db.collection.name": "imovel",
          "db.operation.name": "SELECT",
          outcome: "ok",
        },
        sum: 0.012,
      },
      {
        attributes: {
          "db.collection.name": "parcela",
          "db.operation.name": "INSERT",
          outcome: "ok",
        },
        sum: 0.003,
      },
      {
        attributes: {
          "db.collection.name": "parcela",
          "db.operation.name": "UPDATE",
          outcome: "erro",
        },
        sum: 0.005,
      },
      {
        attributes: {
          "db.collection.name": "imovel",
          "db.operation.name": "DELETE",
          outcome: "ok",
        },
        sum: 0.002,
      },
    ]);
    expect(pontos[0]?.boundaries).toEqual(BUCKETS_DB);
  });

  test("SQL cru e subconsulta no FROM: sem db.collection.name", async () => {
    const middleware = createPrisma8Metrics();
    const ctx = fakeCtx();
    for (const ast of [
      { kind: "raw-query", parts: ["SELECT 1"] },
      { kind: "select", from: { kind: "derived-table-source" } },
      undefined,
    ]) {
      const atividade = statement(ast);
      await middleware.activityEnded(atividade, terminou("succeeded", 1), ctx);
    }

    const pontos = await coletor.histogram("db.client.operation.duration");
    expect(pontos.map((ponto) => [ponto.attributes, ponto.count])).toEqual([
      [{ "db.operation.name": "RAW", outcome: "ok" }, 1],
      [{ "db.operation.name": "SELECT", outcome: "ok" }, 1],
      [{ outcome: "ok" }, 1],
    ]);
  });

  test("resposta do cache (source middleware) não é ida ao banco: não entra", async () => {
    const middleware = createPrisma8Metrics();
    const atividade = statement({ kind: "select", from: tabela("imovel") });
    await middleware.activityEnded(atividade, terminou("succeeded", 0, "middleware"), fakeCtx());
    expect(await coletor.find("db.client.operation.duration")).toBeUndefined();
  });

  test("transação: da abertura ao desfecho final (commit, rollback)", async () => {
    const middleware = createPrisma8Metrics();
    const desfechos = [
      ["committed", 40],
      ["rolled-back", 15],
      ["unknown", 5],
    ] as const;
    for (const [outcome, duracao] of desfechos) {
      const transacao = { id: crypto.randomUUID(), kind: "transaction", annotations: new Map() };
      const ctx = fakeCtx();
      agora = 1_000;
      await middleware.activityStarted(transacao, ctx);
      agora += duracao;
      await middleware.activityEnded(transacao, { kind: "transaction", outcome: "succeeded" }, ctx);
      await middleware.activityFinalized(transacao, { outcome }, ctx);
    }

    const pontos = await coletor.histogram("db.client.transaction.duration");
    expect(pontos.map(({ attributes, sum }) => ({ attributes, sum }))).toEqual([
      { attributes: { outcome: "commit" }, sum: 0.04 },
      { attributes: { outcome: "rollback" }, sum: 0.015 },
      { attributes: { outcome: "desconhecido" }, sum: 0.005 },
    ]);
  });

  test("statement finalizado e chamada do ORM (orm-call) não entram na transação", async () => {
    const middleware = createPrisma8Metrics();
    const ctx = fakeCtx();
    const chamada = { id: "1", kind: "orm-call", annotations: new Map() };
    await middleware.activityStarted(chamada, ctx);
    await middleware.activityEnded(chamada, { kind: "orm-call", outcome: "succeeded" }, ctx);
    await middleware.activityFinalized(chamada, { outcome: "committed" }, ctx);
    await middleware.activityFinalized(statement(undefined), { outcome: "committed" }, ctx);
    expect(await coletor.collect()).toEqual([]);
  });
});

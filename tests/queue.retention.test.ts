import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { QueueJob } from "../src/queue/adapter";
import { SqliteQueueAdapter } from "../src/queue/SqliteQueueAdapter";

const DIA = 24 * 60 * 60 * 1000;
const at = (iso: string) => setSystemTime(new Date(iso));

const job = (id: string, createdAt = Date.now()): QueueJob => ({
  id,
  payload: { id },
  status: "pending",
  createdAt,
});

describe("SqliteQueueAdapter: retenção dos jobs terminados", () => {
  let dir: string;
  let dbPath: string;
  const abertos: SqliteQueueAdapter[] = [];

  const open = (options?: ConstructorParameters<typeof SqliteQueueAdapter>[2]) => {
    const adapter = new SqliteQueueAdapter(dbPath, "jobs", options);
    abertos.push(adapter);
    return adapter;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tsd-queue-ret-"));
    dbPath = path.join(dir, "jobs.db");
  });

  afterEach(() => {
    for (const adapter of abertos.splice(0)) adapter.close();
    setSystemTime();
    rmSync(dir, { recursive: true, force: true });
  });

  test("terminar o job grava finishedAt", () => {
    at("2026-11-05T12:00:00");
    const adapter = open();
    adapter.create(job("a"));
    adapter.update("a", { status: "completed" });

    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT finishedAt FROM jobs WHERE id = 'a'").get() as any;
    db.close();
    expect(row.finishedAt).toBe(new Date("2026-11-05T12:00:00").getTime());
  });

  test("purgeFinished apaga concluído além de 7 dias e falha além de 30, por padrão", () => {
    at("2026-10-01T12:00:00");
    // Só a limpeza explícita: a automática, ao terminar cada job, anteciparia a contagem.
    const adapter = open({ cleanupIntervalMs: Infinity });
    for (const id of ["ok-velho", "falha-velha", "falha-media", "pendente-velho"]) {
      adapter.create(job(id));
    }
    adapter.update("ok-velho", { status: "completed" });
    adapter.update("falha-velha", { status: "failed", error: "x" });

    at("2026-10-20T12:00:00");
    adapter.update("falha-media", { status: "failed", error: "x" });
    at("2026-11-01T12:00:00");
    adapter.create(job("ok-novo"));
    adapter.update("ok-novo", { status: "completed" });

    at("2026-11-05T12:00:00");
    expect(adapter.purgeFinished()).toBe(2);

    const restantes = adapter
      .findMany()
      .map((j) => j.id)
      .sort();
    expect(restantes).toEqual(["falha-media", "ok-novo", "pendente-velho"]);
  });

  test("retenção configurável por status, e Infinity guarda para sempre", () => {
    at("2026-01-01T12:00:00");
    const adapter = open({ completedRetentionMs: DIA, failedRetentionMs: Infinity });
    adapter.create(job("ok"));
    adapter.create(job("falha"));
    adapter.update("ok", { status: "completed" });
    adapter.update("falha", { status: "failed", error: "x" });

    at("2026-11-05T12:00:00");
    adapter.purgeFinished();

    expect(adapter.findMany().map((j) => j.id)).toEqual(["falha"]);
  });

  test("ao abrir, limpa o que já passou da retenção (inclusive linha antiga sem finishedAt)", () => {
    at("2026-01-01T12:00:00");
    const antigo = new SqliteQueueAdapter(dbPath, "jobs");
    antigo.create({ ...job("velho"), status: "completed" });
    antigo.close();
    // Banco de versão anterior: a linha não tem finishedAt e vale pelo createdAt.
    const db = new Database(dbPath);
    db.run("UPDATE jobs SET finishedAt = NULL");
    db.close();

    at("2026-11-05T12:00:00");
    const adapter = open();

    expect(adapter.findMany()).toEqual([]);
  });

  test("terminar um job dispara a limpeza no máximo uma vez por intervalo", () => {
    at("2026-11-01T12:00:00");
    const adapter = open({ completedRetentionMs: 60_000, cleanupIntervalMs: 60 * 60 * 1000 });
    adapter.create(job("a"));
    adapter.update("a", { status: "completed" });

    // Meia hora depois: o "a" já venceu, mas a última limpeza (ao abrir) foi há menos de uma hora.
    at("2026-11-01T12:30:00");
    adapter.create(job("b"));
    adapter.update("b", { status: "completed" });
    expect(adapter.findUnique("a")).not.toBe(null);

    at("2026-11-01T13:01:00");
    adapter.create(job("c"));
    adapter.update("c", { status: "completed" });
    expect(adapter.findUnique("a")).toBe(null);
    expect(adapter.findUnique("b")).toBe(null);
    expect(adapter.findUnique("c")).not.toBe(null);
  });

  test("o job pendente e o em processamento nunca saem", () => {
    at("2020-01-01T12:00:00");
    const adapter = open({ completedRetentionMs: 1, failedRetentionMs: 1 });
    adapter.create(job("pendente"));
    adapter.create(job("rodando"));
    adapter.claim("rodando", Date.now());

    at("2026-11-05T12:00:00");
    adapter.purgeFinished();

    expect(
      adapter
        .findMany()
        .map((j) => j.status)
        .sort(),
    ).toEqual(["pending", "processing"]);
  });

  test("onPurge recebe os jobs apagados", () => {
    at("2026-01-01T12:00:00");
    const apagados: string[] = [];
    const adapter = open({ onPurge: (jobs) => apagados.push(...jobs.map((j) => j.id)) });
    adapter.create(job("a"));
    adapter.update("a", { status: "completed" });

    at("2026-11-05T12:00:00");
    adapter.purgeFinished();

    expect(apagados).toEqual(["a"]);
  });

  test("a busca por status usa índice", () => {
    open();
    const db = new Database(dbPath, { readonly: true });
    const plano = db
      .query("EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE status = ? ORDER BY createdAt ASC")
      .all("pending") as Array<{ detail: string }>;
    db.close();
    expect(plano.map((p) => p.detail).join(" ")).toContain("USING INDEX");
  });
});

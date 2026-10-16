import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { QueueAdapter, QueueJob } from "../src/queue/adapter";
import { InMemoryQueueAdapter } from "../src/queue/InMemoryQueueAdapter";
import {
  clearQueues,
  enqueue,
  registerProcessor,
  registerQueue,
  startProcessors,
  stopProcessors,
} from "../src/queue/registry";
import { SqliteQueueAdapter } from "../src/queue/SqliteQueueAdapter";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildJob = (id: string, patch: Partial<QueueJob> = {}): QueueJob => ({
  id,
  payload: { id },
  status: "pending",
  createdAt: 1,
  ...patch,
});

const adapters: [nome: string, criar: () => QueueAdapter][] = [
  ["InMemoryQueueAdapter", () => new InMemoryQueueAdapter()],
  ["SqliteQueueAdapter", () => new SqliteQueueAdapter(":memory:", "fila")],
];

describe.each(adapters)("%s: reserva do job", (_nome, criar) => {
  test("só o primeiro que reserva leva o job", async () => {
    const adapter = criar();
    await adapter.create(buildJob("a"));

    expect(await adapter.claim!("a", 1000)).toBe(true);
    expect(await adapter.claim!("a", 2000)).toBe(false);
  });

  test("a reserva marca o job como em processamento, com o instante", async () => {
    const adapter = criar();
    await adapter.create(buildJob("a"));
    await adapter.claim!("a", 1000);

    expect(await adapter.findUnique("a")).toMatchObject({ status: "processing", lockedAt: 1000 });
  });

  test("job que não existe não é reservado", async () => {
    expect(await criar().claim!("nao-existe", 1000)).toBe(false);
  });

  test("update grava e limpa o lockedAt", async () => {
    const adapter = criar();
    await adapter.create(buildJob("a", { status: "processing", lockedAt: 5 }));
    expect((await adapter.findUnique("a"))?.lockedAt).toBe(5);

    await adapter.update("a", { status: "pending", lockedAt: undefined });
    expect((await adapter.findUnique("a"))?.lockedAt).toBeUndefined();
  });
});

describe("SqliteQueueAdapter: banco criado por versão anterior", () => {
  test("ganha a coluna lockedAt sem perder os jobs", () => {
    const pasta = mkdtempSync(path.join(tmpdir(), "fila-"));
    const arquivo = path.join(pasta, "fila.db");
    const antigo = new Database(arquivo, { create: true });
    antigo.exec(
      "CREATE TABLE fila (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, error TEXT)",
    );
    antigo.run("INSERT INTO fila VALUES ('a', '{\"id\":\"a\"}', 'pending', 1, NULL)");
    antigo.close();

    const adapter = new SqliteQueueAdapter(arquivo, "fila");
    expect(adapter.claim("a", 77)).toBe(true);
    expect(adapter.findUnique("a")).toMatchObject({ status: "processing", lockedAt: 77 });
    adapter.close();
    rmSync(pasta, { recursive: true, force: true });
  });
});

describe("filas: dois consumidores e jobs órfãos", () => {
  afterEach(() => {
    clearQueues();
  });

  const startFila = (
    adapter: QueueAdapter,
    handler: (payload: { id: string }) => unknown,
    opcoes: { staleAfterMs?: number; concurrency?: number } = {},
  ) => {
    registerQueue("fila", adapter);
    registerProcessor("fila", { handler, concurrency: 2, pollMs: 10, ...opcoes });
    startProcessors();
  };

  test("job que outro processo reservou primeiro não roda aqui", async () => {
    // O outro processo ganha a corrida entre a leitura dos pendentes e a reserva.
    class PerdeACorrida extends InMemoryQueueAdapter {
      override claim(): boolean {
        return false;
      }
    }
    const executados: string[] = [];
    const adapter = new PerdeACorrida();
    startFila(adapter, (payload) => executados.push(payload.id));
    await enqueue("fila", { id: "a" });
    await delay(60);

    expect(executados).toEqual([]);
    expect(adapter.findMany().map((job) => job.status)).toEqual(["pending"]);
  });

  test("perder a reserva devolve a vaga para o próximo job", async () => {
    class PerdeSoOPrimeiro extends InMemoryQueueAdapter {
      private tentativas = 0;
      override claim(id: string, agora: number): boolean {
        this.tentativas += 1;
        return this.tentativas > 1 && super.claim(id, agora);
      }
    }
    const executados: string[] = [];
    startFila(new PerdeSoOPrimeiro(), (payload) => executados.push(payload.id), { concurrency: 1 });
    await enqueue("fila", { id: "a" });
    await delay(60);

    expect(executados).toEqual(["a"]);
  });

  test("job órfão (processo caiu) volta para a fila e roda", async () => {
    const adapter = new InMemoryQueueAdapter();
    adapter.create(buildJob("orfao", { status: "processing", lockedAt: Date.now() - 60_000 }));
    const executados: string[] = [];
    startFila(adapter, (payload) => executados.push(payload.id), { staleAfterMs: 30 });
    await delay(80);

    expect(executados).toEqual(["orfao"]);
    expect(adapter.findUnique("orfao")?.status).toBe("completed");
  });

  test("job em processamento gravado por versão anterior, sem lockedAt, é órfão", async () => {
    const adapter = new InMemoryQueueAdapter();
    adapter.create(buildJob("antigo", { status: "processing" }));
    const executados: string[] = [];
    startFila(adapter, (payload) => executados.push(payload.id), { staleAfterMs: 30 });
    await delay(80);

    expect(executados).toEqual(["antigo"]);
  });

  test("job que outro processo vivo está rodando não é tomado", async () => {
    const adapter = new InMemoryQueueAdapter();
    adapter.create(buildJob("alheio", { status: "processing", lockedAt: Date.now() }));
    const executados: string[] = [];
    startFila(adapter, (payload) => executados.push(payload.id), { staleAfterMs: 5_000 });
    await delay(60);

    expect(executados).toEqual([]);
    expect(adapter.findUnique("alheio")?.status).toBe("processing");
  });

  test("job demorado deste processo não é tomado como órfão", async () => {
    const adapter = new InMemoryQueueAdapter();
    let execucoes = 0;
    startFila(
      adapter,
      async () => {
        execucoes += 1;
        await delay(150);
      },
      { staleAfterMs: 30 },
    );
    await enqueue("fila", { id: "longo" });
    await delay(220);

    expect(execucoes).toBe(1);
  });

  test("o job em andamento renova o lockedAt", async () => {
    const adapter = new InMemoryQueueAdapter();
    startFila(adapter, () => delay(150), { staleAfterMs: 30 });
    const job = await enqueue("fila", { id: "longo" });
    await delay(30);
    const primeiro = adapter.findUnique(job.id)?.lockedAt ?? 0;
    await delay(80);

    expect(adapter.findUnique(job.id)?.lockedAt ?? 0).toBeGreaterThan(primeiro);
  });

  test("parar o consumo não para a renovação do job em andamento", async () => {
    const adapter = new InMemoryQueueAdapter();
    startFila(adapter, () => delay(150), { staleAfterMs: 30 });
    const job = await enqueue("fila", { id: "longo" });
    await delay(30);
    stopProcessors();
    const aoParar = adapter.findUnique(job.id)?.lockedAt ?? 0;
    await delay(80);

    expect(adapter.findUnique(job.id)?.status).toBe("processing");
    expect(adapter.findUnique(job.id)?.lockedAt ?? 0).toBeGreaterThan(aoParar);
  });

  test("sem job em andamento, não sobra timer de renovação", async () => {
    const adapter = new InMemoryQueueAdapter();
    let renovacoes = 0;
    const original = adapter.update.bind(adapter);
    adapter.update = (id, patch) => {
      if (patch.lockedAt !== undefined && patch.status === undefined) renovacoes += 1;
      return original(id, patch);
    };
    startFila(adapter, () => delay(40), { staleAfterMs: 30 });
    await enqueue("fila", { id: "curto" });
    await delay(80);
    const aoTerminar = renovacoes;
    await delay(60);

    expect(renovacoes).toBe(aoTerminar);
  });

  test("ao terminar, o job fica sem lockedAt", async () => {
    const adapter = new InMemoryQueueAdapter();
    startFila(adapter, () => undefined);
    const job = await enqueue("fila", { id: "a" });
    await delay(50);

    expect(adapter.findUnique(job.id)).toMatchObject({ status: "completed" });
    expect(adapter.findUnique(job.id)?.lockedAt).toBeUndefined();
  });

  test("adapter sem claim continua funcionando", async () => {
    const base = new InMemoryQueueAdapter();
    const semClaim: QueueAdapter = {
      findMany: (filtro) => base.findMany(filtro),
      findUnique: (id) => base.findUnique(id),
      create: (job) => base.create(job),
      update: (id, patch) => base.update(id, patch),
      delete: (id) => base.delete(id),
    };
    const executados: string[] = [];
    startFila(semClaim, (payload) => executados.push(payload.id));
    await enqueue("fila", { id: "a" });
    await delay(50);

    expect(executados).toEqual(["a"]);
  });
});

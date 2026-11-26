import { afterEach, describe, expect, test } from "bun:test";

import { Processor } from "../src/decorators/processor";
import { Queue } from "../src/decorators/queue";
import type { QueueAdapter, QueueJob } from "../src/queue/adapter";
import { InMemoryQueueAdapter } from "../src/queue/InMemoryQueueAdapter";
import {
  clearQueues,
  getQueueAdapter,
  getQueueJobs,
  getQueueStats,
  listQueues,
  purgeQueue,
  registerProcessor,
  registerQueue,
  removeQueueJob,
  retryQueueJob,
  startProcessors,
} from "../src/queue/registry";
import { SqliteQueueAdapter } from "../src/queue/SqliteQueueAdapter";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Queue adapters (interface comum)", () => {
  test("InMemoryQueueAdapter faz CRUD", () => {
    const a = new InMemoryQueueAdapter();
    a.create({ id: "1", payload: { x: 1 }, status: "pending", createdAt: 1 });
    expect((a.findUnique("1") as any).payload).toEqual({ x: 1 });
    a.update("1", { status: "completed" });
    expect((a.findUnique("1") as any).status).toBe("completed");
    expect((a.findMany({ status: "completed" }) as any[]).length).toBe(1);
    a.delete("1");
    expect(a.findUnique("1")).toBeNull();
  });

  test("SqliteQueueAdapter (memória) faz CRUD", () => {
    const a = new SqliteQueueAdapter(":memory:", "t");
    a.create({ id: "1", payload: { x: 2 }, status: "pending", createdAt: 1 });
    expect((a.findUnique("1") as any).payload).toEqual({ x: 2 });
    a.update("1", { status: "failed", error: "boom" });
    expect((a.findUnique("1") as any).error).toBe("boom");
    a.delete("1");
    expect(a.findUnique("1")).toBeNull();
  });
});

describe("@Queue / @Processor", () => {
  afterEach(() => {
    clearQueues();
  });

  test("@Queue registra a fila e expõe enqueue; @Processor consome", async () => {
    const processed: any[] = [];

    @Queue({ name: "jobs", adapter: new InMemoryQueueAdapter() })
    class JobsQueue {}

    class JobsWorker {
      @Processor("jobs", { concurrency: 2, pollMs: 5 })
      async handle(payload: any) {
        processed.push(payload);
      }
    }

    // registra o processor (legacy: via initProcessors/startProcessors)
    const { initProcessors } = await import("../src/decorators/processor");
    initProcessors(new JobsWorker());
    startProcessors();

    const q = new JobsQueue() as any;
    await q.enqueue({ task: "a" });
    await q.enqueue({ task: "b" });

    await delay(60);
    expect(processed).toEqual(expect.arrayContaining([{ task: "a" }, { task: "b" }]));

    const adapter = getQueueAdapter("jobs")!;
    const completed = (await adapter.findMany({ status: "completed" })) as any[];
    expect(completed.length).toBe(2);
  });
});

/**
 * Estado das filas para health check: quais existem, se o consumidor está rodando e quantos jobs
 * há em cada status. O registro era privado, e o monitoramento não tinha como saber que uma fila
 * parou ou acumulou falhas.
 */
describe("estatísticas das filas", () => {
  afterEach(() => {
    clearQueues();
  });

  test("countByStatus do SQLite conta sem carregar os payloads", () => {
    const a = new SqliteQueueAdapter(":memory:", "c");
    a.create({ id: "1", payload: {}, status: "pending", createdAt: 1 });
    a.create({ id: "2", payload: {}, status: "pending", createdAt: 1 });
    a.create({ id: "3", payload: {}, status: "failed", createdAt: 1, error: "x" });

    expect(a.countByStatus()).toEqual({ pending: 2, processing: 0, completed: 0, failed: 1 });
  });

  test("countByStatus do adaptador em memória", () => {
    const a = new InMemoryQueueAdapter();
    a.create({ id: "1", payload: {}, status: "completed", createdAt: 1 });

    expect(a.countByStatus()).toEqual({ pending: 0, processing: 0, completed: 1, failed: 0 });
  });

  test("listQueues e getQueueStats trazem cada fila, com e sem consumidor", async () => {
    const adapter = new InMemoryQueueAdapter();
    registerQueue("com-consumidor", adapter);
    registerProcessor("com-consumidor", { handler: async () => {}, concurrency: 3, pollMs: 1000 });
    registerQueue("sem-consumidor", new InMemoryQueueAdapter());
    adapter.create({ id: "1", payload: {}, status: "failed", createdAt: 1, error: "x" });
    startProcessors();

    expect(listQueues().sort()).toEqual(["com-consumidor", "sem-consumidor"]);
    const stats = await getQueueStats();
    const withConsumidor = stats.find((s) => s.name === "com-consumidor");

    expect(withConsumidor).toEqual({
      name: "com-consumidor",
      hasProcessor: true,
      running: true,
      paused: false,
      concurrency: 3,
      inFlight: 0,
      counts: { pending: 0, processing: 0, completed: 0, failed: 1 },
    });
    expect(stats.find((s) => s.name === "sem-consumidor")).toMatchObject({
      hasProcessor: false,
      running: false,
      concurrency: 0,
    });
  });

  test("adaptador sem countByStatus conta pelo findMany", async () => {
    const withoutContagem: QueueAdapter = {
      findMany: (filter) => (filter?.status === "pending" ? [{} as QueueJob, {} as QueueJob] : []),
      findUnique: () => null,
      create: (job) => job,
      update: () => null,
      delete: () => {},
    };
    registerQueue("legada", withoutContagem);

    const [stats] = await getQueueStats();
    expect(stats.counts).toEqual({ pending: 2, processing: 0, completed: 0, failed: 0 });
  });
});

/**
 * Operações do painel de filas: ver os jobs, reprocessar o que falhou, remover um job parado e
 * limpar os concluídos. Nenhuma mexe em job que está em processamento.
 */
describe("operações sobre os jobs de uma fila", () => {
  afterEach(() => {
    clearQueues();
  });

  const preparar = () => {
    const adapter = new SqliteQueueAdapter(":memory:", "ops");
    registerQueue("ops", adapter);
    adapter.create({ id: "p1", payload: { n: 1 }, status: "pending", createdAt: 1 });
    adapter.create({ id: "f1", payload: { n: 2 }, status: "failed", createdAt: 2, error: "boom" });
    adapter.create({ id: "c1", payload: { n: 3 }, status: "completed", createdAt: 3 });
    adapter.create({ id: "c2", payload: { n: 4 }, status: "completed", createdAt: 4 });
    adapter.create({ id: "r1", payload: { n: 5 }, status: "processing", createdAt: 5 });
    return adapter;
  };

  test("getQueueJobs traz os mais recentes primeiro, com filtro e limite", async () => {
    preparar();

    expect((await getQueueJobs("ops", { limit: 2 })).map((job) => job.id)).toEqual(["r1", "c2"]);
    expect((await getQueueJobs("ops", { status: "completed" })).map((job) => job.id)).toEqual([
      "c2",
      "c1",
    ]);
  });

  test("retryQueueJob devolve o falho para pendente, sem o erro", async () => {
    const adapter = preparar();

    await retryQueueJob("ops", "f1");

    expect(adapter.findUnique("f1")).toMatchObject({ status: "pending", error: undefined });
  });

  test("retryQueueJob recusa job que não falhou", async () => {
    preparar();

    await expect(retryQueueJob("ops", "c1")).rejects.toThrow(
      "Só job com falha pode ser reprocessado.",
    );
  });

  test("removeQueueJob apaga o job parado e recusa o que está em processamento", async () => {
    const adapter = preparar();

    await removeQueueJob("ops", "p1");
    expect(adapter.findUnique("p1")).toBeNull();
    await expect(removeQueueJob("ops", "r1")).rejects.toThrow(
      "Job em processamento não pode ser removido.",
    );
  });

  test("purgeQueue limpa só concluídos ou falhos e diz quantos saíram", async () => {
    const adapter = preparar();

    expect(await purgeQueue("ops", "completed")).toBe(2);
    expect(adapter.countByStatus()).toMatchObject({ completed: 0, pending: 1, failed: 1 });
    await expect(purgeQueue("ops", "pending" as never)).rejects.toThrow(
      "Só é possível limpar jobs concluídos ou com falha.",
    );
  });

  test("fila inexistente falha alto", async () => {
    await expect(getQueueJobs("nao-existe")).rejects.toThrow('Fila não registrada: "nao-existe"');
  });
});

/**
 * Limite de jobs em voo POR CHAVE. `keyOf` sozinho serializa (um por chave); `maxPerKey` deixa a
 * mesma chave ter até N em voo — o excedente espera "pending", sem ocupar vaga da fila. É o que
 * permite "cada entidade roda até 3 ao mesmo tempo" sem recusar a quarta requisição.
 */
describe("limite de jobs em voo por chave (keyOf + maxPerKey)", () => {
  afterEach(() => {
    clearQueues();
  });

  type Payload = { key: string; n: number };

  /** Fila em memória cujo handler segura cada job por `ms` e mede o pico em voo, por chave e no total. */
  function buildFila(options: { concurrency: number; maxPerKey?: number; ms?: number }) {
    const adapter = new InMemoryQueueAdapter();
    const emVoo = new Map<string, number>();
    const pico = new Map<string, number>();
    let total = 0;
    let picoTotal = 0;
    const concluidos: number[] = [];

    registerQueue("por-chave", adapter);
    registerProcessor("por-chave", {
      concurrency: options.concurrency,
      pollMs: 5,
      keyOf: (payload: Payload) => payload.key,
      ...(options.maxPerKey === undefined ? {} : { maxPerKey: options.maxPerKey }),
      handler: async (payload: Payload) => {
        const agora = (emVoo.get(payload.key) ?? 0) + 1;
        emVoo.set(payload.key, agora);
        pico.set(payload.key, Math.max(pico.get(payload.key) ?? 0, agora));
        total++;
        picoTotal = Math.max(picoTotal, total);
        await delay(options.ms ?? 25);
        emVoo.set(payload.key, (emVoo.get(payload.key) ?? 1) - 1);
        total--;
        concluidos.push(payload.n);
      },
    });

    const enqueueMany = (key: string, quantos: number, inicio = 0) => {
      for (let n = 0; n < quantos; n++) {
        adapter.create({
          id: `${key}-${inicio + n}`,
          payload: { key, n: inicio + n },
          status: "pending",
          createdAt: inicio + n,
        });
      }
    };

    return { adapter, pico, concluidos, enqueueMany, picoTotal: () => picoTotal };
  }

  test("sem maxPerKey, a chave continua com um job em voo por vez", async () => {
    const fila = buildFila({ concurrency: 10 });
    fila.enqueueMany("entidade-4", 4);
    startProcessors();

    await delay(200);

    expect(fila.pico.get("entidade-4")).toBe(1);
    expect(fila.concluidos).toHaveLength(4);
  });

  test("com maxPerKey 3, a chave roda até 3 juntos e o excedente espera pendente", async () => {
    const fila = buildFila({ concurrency: 10, maxPerKey: 3, ms: 40 });
    fila.enqueueMany("entidade-4", 5);
    startProcessors();

    await delay(20);
    const processando = fila.adapter.findMany({ status: "processing" }) as QueueJob[];
    const pendentes = fila.adapter.findMany({ status: "pending" }) as QueueJob[];
    expect(processando).toHaveLength(3);
    expect(pendentes).toHaveLength(2);

    await delay(250);
    expect(fila.pico.get("entidade-4")).toBe(3);
    expect(fila.concluidos).toHaveLength(5);
  });

  test("o limite é de cada chave: duas entidades rodam 3 cada uma, ao mesmo tempo", async () => {
    const fila = buildFila({ concurrency: 10, maxPerKey: 3, ms: 40 });
    fila.enqueueMany("entidade-4", 4);
    fila.enqueueMany("entidade-11", 4, 100);
    startProcessors();

    await delay(300);

    expect(fila.pico.get("entidade-4")).toBe(3);
    expect(fila.pico.get("entidade-11")).toBe(3);
    expect(fila.picoTotal()).toBe(6);
    expect(fila.concluidos).toHaveLength(8);
  });

  test("a concorrência da fila continua sendo o teto, acima do limite por chave", async () => {
    const fila = buildFila({ concurrency: 2, maxPerKey: 3, ms: 30 });
    fila.enqueueMany("entidade-4", 5);
    startProcessors();

    await delay(300);

    expect(fila.pico.get("entidade-4")).toBe(2);
    expect(fila.picoTotal()).toBe(2);
    expect(fila.concluidos).toHaveLength(5);
  });

  test("a chave cheia não segura a fila: o job de outra chave passa na frente", async () => {
    const fila = buildFila({ concurrency: 10, maxPerKey: 1, ms: 60 });
    fila.enqueueMany("entidade-4", 3);
    fila.enqueueMany("entidade-11", 1, 100);
    startProcessors();

    await delay(30);

    const processando = fila.adapter.findMany({ status: "processing" }) as QueueJob<Payload>[];
    expect(processando.map((job) => job.payload.key).sort()).toEqual(["entidade-11", "entidade-4"]);
  });

  test("maxPerKey menor que 1 vale 1", async () => {
    const fila = buildFila({ concurrency: 10, maxPerKey: 0 });
    fila.enqueueMany("entidade-4", 3);
    startProcessors();

    await delay(150);

    expect(fila.pico.get("entidade-4")).toBe(1);
    expect(fila.concluidos).toHaveLength(3);
  });

  test("@Processor repassa maxPerKey ao registro", async () => {
    let emVoo = 0;
    let pico = 0;

    @Queue({ name: "duplicacoes", adapter: new InMemoryQueueAdapter() })
    class DuplicacoesQueue {}

    class DuplicacoesWorker {
      @Processor("duplicacoes", {
        concurrency: 10,
        pollMs: 5,
        keyOf: (payload: { entidade: number }) => payload.entidade,
        maxPerKey: 2,
      })
      async handle() {
        emVoo++;
        pico = Math.max(pico, emVoo);
        await delay(30);
        emVoo--;
      }
    }

    const { initProcessors } = await import("../src/decorators/processor");
    initProcessors(new DuplicacoesWorker());
    const fila = new DuplicacoesQueue() as unknown as { enqueue(p: object): Promise<unknown> };
    for (let n = 0; n < 4; n++) await fila.enqueue({ entidade: 4 });

    await delay(200);

    expect(pico).toBe(2);
  });
});

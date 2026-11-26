import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initProcessors, Processor } from "../src/decorators/processor";
import { setHandlerContext } from "../src/handlers/context";
import type { QueueAdapter, QueueJob } from "../src/queue/adapter";
import { InMemoryQueueAdapter } from "../src/queue/InMemoryQueueAdapter";
import { findTenantDoPayload, type PerTenantOptions } from "../src/queue/perTenant";
import {
  clearQueues,
  getInFlightCount,
  pauseProcessors,
  registerProcessor,
  registerQueue,
  resumeProcessors,
  startProcessors,
} from "../src/queue/registry";
import { SqliteQueueAdapter } from "../src/queue/SqliteQueueAdapter";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Espera a condição valer, sem depender de um tempo fixo (a máquina pode estar carregada). */
async function waitUntil(isPronto: () => boolean, timeoutMs = 3_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (!isPronto()) {
    if (Date.now() > limite) throw new Error("A condição não foi atendida a tempo.");
    await delay(5);
  }
}

type Payload = { tenant?: string; nome: string };

const adapters: [nome: string, criar: () => QueueAdapter][] = [
  ["InMemoryQueueAdapter", () => new InMemoryQueueAdapter()],
  ["SqliteQueueAdapter", () => new SqliteQueueAdapter(":memory:", "municipios")],
];

/** Grava `quantos` jobs pendentes da tenant, com `createdAt` crescente a partir de `inicio`. */
async function createJobs(
  adapter: QueueAdapter,
  tenant: string | undefined,
  quantos: number,
  inicio: number,
): Promise<void> {
  for (let n = 0; n < quantos; n++) {
    const nome = `${tenant ?? "sem"}${n}`;
    await adapter.create({
      id: nome,
      payload: { tenant, nome },
      status: "pending",
      createdAt: inicio + n,
    });
  }
}

/**
 * Fila "municipios" cujo consumidor segura cada job por `ms` e registra a ordem de início e o
 * pico em voo, por tenant e no total.
 */
function buildFila(
  adapter: QueueAdapter,
  options: { concurrency: number; perTenant?: PerTenantOptions; ms?: number },
) {
  const inicios: string[] = [];
  const concluidos: string[] = [];
  const emVoo = new Map<string, number>();
  const pico = new Map<string, number>();
  let total = 0;
  let picoTotal = 0;

  registerQueue("municipios", adapter);
  registerProcessor("municipios", {
    concurrency: options.concurrency,
    pollMs: 5,
    ...(options.perTenant ? { perTenant: options.perTenant } : {}),
    handler: async (payload: Payload) => {
      const chave = payload.tenant ?? "sem";
      const agora = (emVoo.get(chave) ?? 0) + 1;
      emVoo.set(chave, agora);
      pico.set(chave, Math.max(pico.get(chave) ?? 0, agora));
      total++;
      picoTotal = Math.max(picoTotal, total);
      inicios.push(payload.nome);
      await delay(options.ms ?? 30);
      emVoo.set(chave, (emVoo.get(chave) ?? 1) - 1);
      total--;
      concluidos.push(payload.nome);
    },
  });

  return { inicios, concluidos, pico, picoTotal: () => picoTotal };
}

afterEach(() => {
  clearQueues();
  setHandlerContext(() => undefined);
});

describe.each(adapters)("%s: perTenant no consumo", (_nome, criar) => {
  test("a tenant com muitos jobs não faz a outra esperar", async () => {
    const adapter = criar();
    const fila = buildFila(adapter, { concurrency: 4, perTenant: { concurrency: 2 }, ms: 60 });
    await createJobs(adapter, "A", 20, 1);
    await createJobs(adapter, "B", 2, 100);
    startProcessors();

    await waitUntil(() => fila.inicios.length >= 4);

    expect(fila.inicios.slice(0, 4).sort()).toEqual(["A0", "A1", "B0", "B1"]);
  });

  test("o worker livre vai para a tenant que tem menos jobs rodando", async () => {
    // A ocupa a fila inteira se puder (o limite dela é igual ao da fila). Na ordem de chegada, B
    // só rodaria depois do último job de A.
    const adapter = criar();
    const fila = buildFila(adapter, { concurrency: 2, perTenant: { concurrency: 2 } });
    await createJobs(adapter, "A", 6, 1);
    await createJobs(adapter, "B", 1, 100);
    startProcessors();

    await waitUntil(() => fila.inicios.length >= 2);

    expect(fila.inicios.slice(0, 2).sort()).toEqual(["A0", "B0"]);
  });

  test("o limite da tenant vale com muitos jobs e vagas sobrando", async () => {
    const adapter = criar();
    const fila = buildFila(adapter, { concurrency: 10, perTenant: { concurrency: 3 }, ms: 15 });
    await createJobs(adapter, "A", 15, 1);
    await createJobs(adapter, "B", 15, 100);
    await createJobs(adapter, "C", 2, 200);
    startProcessors();

    await waitUntil(() => fila.concluidos.length === 32);

    expect(fila.pico.get("A")).toBe(3);
    expect(fila.pico.get("B")).toBe(3);
    expect(fila.pico.get("C")).toBe(2);
    expect(fila.picoTotal()).toBeLessThanOrEqual(8);
  });

  test("o job da tenant cheia roda quando ela libera", async () => {
    const adapter = criar();
    const fila = buildFila(adapter, { concurrency: 5, perTenant: { concurrency: 1 }, ms: 10 });
    await createJobs(adapter, "A", 3, 1);
    startProcessors();

    await waitUntil(() => fila.concluidos.length === 3);

    expect(fila.inicios).toEqual(["A0", "A1", "A2"]);
    expect(fila.pico.get("A")).toBe(1);
    expect((await adapter.findMany({ status: "completed" })).length).toBe(3);
  });

  test("job sem tenant não tem limite por tenant", async () => {
    const adapter = criar();
    const fila = buildFila(adapter, { concurrency: 3, perTenant: { concurrency: 1 }, ms: 40 });
    await createJobs(adapter, undefined, 3, 1);
    startProcessors();

    await waitUntil(() => fila.concluidos.length === 3);

    expect(fila.picoTotal()).toBe(3);
  });

  test("pausado, não puxa job novo; o em voo termina e é contado", async () => {
    const adapter = criar();
    const fila = buildFila(adapter, { concurrency: 2, perTenant: { concurrency: 1 }, ms: 60 });
    await createJobs(adapter, "A", 2, 1);
    startProcessors();
    await waitUntil(() => fila.inicios.length === 1);

    pauseProcessors();
    expect(getInFlightCount()).toBe(1);
    await waitUntil(() => fila.concluidos.length === 1);
    await delay(40);
    expect(fila.inicios).toEqual(["A0"]);
    expect(getInFlightCount()).toBe(0);

    resumeProcessors();
    await waitUntil(() => fila.concluidos.length === 2);
  });

  test("sem perTenant, a ordem continua a de chegada", async () => {
    const adapter = criar();
    const fila = buildFila(adapter, { concurrency: 2 });
    await createJobs(adapter, "A", 4, 1);
    await createJobs(adapter, "B", 1, 100);
    startProcessors();

    await waitUntil(() => fila.inicios.length >= 2);

    expect(fila.inicios.slice(0, 2)).toEqual(["A0", "A1"]);
  });
});

describe.each(adapters)("%s: findPendingPerTenant", (_nome, criar) => {
  const tenantOf = (payload: Payload) => payload.tenant ?? "";

  test("intercala as tenants e pula o que passa do limite", async () => {
    const adapter = criar();
    await createJobs(adapter, "A", 4, 1);
    await createJobs(adapter, "B", 2, 100);
    await createJobs(adapter, "C", 1, 200);
    await adapter.claim!("A0", 1, { tenant: "A", concurrency: 2 });

    const jobs = await adapter.findPendingPerTenant!({ limit: 10, concurrency: 2, tenantOf });

    // A já tem um rodando: só mais um dela cabe. B e C entram na frente do segundo de cada uma.
    expect(jobs.map((job) => job.id)).toEqual(["B0", "C0", "A1", "B1"]);
  });

  test("devolve no máximo `limit` jobs", async () => {
    const adapter = criar();
    await createJobs(adapter, "A", 3, 1);
    await createJobs(adapter, "B", 3, 100);

    const jobs = await adapter.findPendingPerTenant!({ limit: 3, concurrency: 5, tenantOf });

    expect(jobs.map((job) => job.id)).toEqual(["A0", "B0", "A1"]);
  });

  test("grava a tenant no job e a devolve", async () => {
    const adapter = criar();
    await createJobs(adapter, "A", 1, 1);
    await createJobs(adapter, undefined, 1, 2);

    const jobs = await adapter.findPendingPerTenant!({ limit: 10, concurrency: 1, tenantOf });

    expect(jobs.map((job) => job.tenant)).toEqual(["A", ""]);
    expect((await adapter.findUnique("A0"))?.tenant).toBe("A");
  });

  test("o processing gravado sem tenant conta para a tenant dele", async () => {
    const adapter = criar();
    await adapter.create({
      id: "antigo",
      payload: { tenant: "A", nome: "antigo" },
      status: "processing",
      createdAt: 1,
      lockedAt: Date.now(),
    });
    await createJobs(adapter, "A", 1, 2);

    const jobs = await adapter.findPendingPerTenant!({ limit: 10, concurrency: 1, tenantOf });

    expect(jobs).toEqual([]);
  });

  test("a reserva com limite recusa a tenant cheia", async () => {
    const adapter = criar();
    await createJobs(adapter, "A", 2, 1);
    const limite = { tenant: "A", concurrency: 1 };

    expect(await adapter.claim!("A0", 1, limite)).toBe(true);
    expect(await adapter.claim!("A1", 1, limite)).toBe(false);
    await adapter.update("A0", { status: "completed", lockedAt: undefined });
    expect(await adapter.claim!("A1", 1, limite)).toBe(true);
    expect(await adapter.findUnique("A1")).toMatchObject({ status: "processing", tenant: "A" });
  });
});

describe("SqliteQueueAdapter: perTenant entre processos e no reinício", () => {
  const pastas: string[] = [];
  const buildArquivo = () => {
    const pasta = mkdtempSync(path.join(tmpdir(), "fila-tenant-"));
    pastas.push(pasta);
    return path.join(pasta, "fila.db");
  };

  afterEach(() => {
    for (const pasta of pastas.splice(0)) rmSync(pasta, { recursive: true, force: true });
  });

  test("dois processos na mesma tabela não passam do limite da tenant", async () => {
    const arquivo = buildArquivo();
    const processo1 = new SqliteQueueAdapter(arquivo, "fila");
    const processo2 = new SqliteQueueAdapter(arquivo, "fila");
    await createJobs(processo1, "A", 2, 1);
    const limite = { tenant: "A", concurrency: 1 };

    expect(processo1.claim("A0", 1, limite)).toBe(true);
    expect(processo2.claim("A1", 1, limite)).toBe(false);
    processo1.close();
    processo2.close();
  });

  test("banco de versão anterior ganha a coluna tenant e o índice, sem perder os jobs", () => {
    const arquivo = buildArquivo();
    const antigo = new Database(arquivo, { create: true });
    antigo.exec(
      "CREATE TABLE fila (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, error TEXT, lockedAt INTEGER)",
    );
    antigo.run(
      `INSERT INTO fila VALUES ('a', '{"tenant":"A","nome":"a"}', 'pending', 1, NULL, NULL)`,
    );
    antigo.close();

    const adapter = new SqliteQueueAdapter(arquivo, "fila");
    const jobs = adapter.findPendingPerTenant({
      limit: 10,
      concurrency: 1,
      tenantOf: (payload: Payload) => payload.tenant ?? "",
    });

    expect(jobs.map((job) => job.id)).toEqual(["a"]);
    const db = new Database(arquivo);
    const indices = db.query("PRAGMA index_list(fila)").all() as { name: string }[];
    expect(indices.map((indice) => indice.name)).toContain("fila_status_tenant");
    db.close();
    adapter.close();
  });

  test("reinício: o job do processo que caiu volta para a fila e libera a vaga da tenant", async () => {
    // O processo anterior reservou A0 e caiu: o job ficou "processing", sem renovação.
    const adapter = new SqliteQueueAdapter(":memory:", "fila");
    await createJobs(adapter, "A", 2, 1);
    adapter.claim("A0", Date.now() - 60_000, { tenant: "A", concurrency: 1 });

    const executados: string[] = [];
    registerQueue("fila", adapter);
    registerProcessor("fila", {
      concurrency: 2,
      pollMs: 10,
      staleAfterMs: 30,
      perTenant: { concurrency: 1 },
      handler: (payload: Payload) => {
        executados.push(payload.nome);
      },
    });
    startProcessors();

    await waitUntil(() => executados.length === 2);

    expect(executados.sort()).toEqual(["A0", "A1"]);
  });
});

describe("adapter sem findPendingPerTenant", () => {
  /** Só os cinco métodos obrigatórios: a fila escolhe pelo findMany. */
  class ListaQueueAdapter implements QueueAdapter {
    private readonly jobs: QueueJob[] = [];
    findMany(filter: Partial<QueueJob> = {}) {
      return this.jobs.filter((job) => !filter.status || job.status === filter.status);
    }
    findUnique(id: string) {
      return this.jobs.find((job) => job.id === id) ?? null;
    }
    create(job: QueueJob) {
      this.jobs.push({ ...job });
      return job;
    }
    update(id: string, patch: Partial<QueueJob>) {
      const job = this.findUnique(id);
      return job ? Object.assign(job, patch) : null;
    }
    delete() {}
  }

  test("respeita o limite e intercala as tenants", async () => {
    const adapter = new ListaQueueAdapter();
    const fila = buildFila(adapter, { concurrency: 2, perTenant: { concurrency: 2 }, ms: 15 });
    await createJobs(adapter, "A", 6, 1);
    await createJobs(adapter, "B", 1, 100);
    startProcessors();

    await waitUntil(() => fila.concluidos.length === 7);

    expect(fila.inicios.slice(0, 2).sort()).toEqual(["A0", "B0"]);
    expect(fila.pico.get("A")).toBe(2);
  });
});

describe("tenant padrão do payload", () => {
  test.each([
    ["payload.tenant", { tenant: 79 }, 79],
    ["payload.ctx.tenant", { ctx: { tenant: 4, entity: 99 } }, 4],
    ["payload.ctx.entity", { ctx: { entity: 12 } }, 12],
    ["payload.companyId", { companyId: "c-1" }, "c-1"],
    ["payload.user.entidade", { user: { entidade: "11" } }, "11"],
  ])("%s", (_caminho, payload, esperada) => {
    expect(findTenantDoPayload(payload)).toBe(esperada);
  });

  test("0, texto vazio e payload sem tenant não têm tenant", () => {
    expect(findTenantDoPayload({ tenant: 0 })).toBeUndefined();
    expect(findTenantDoPayload({ ctx: { tenant: "" } })).toBeUndefined();
    expect(findTenantDoPayload({ nome: "x" })).toBeUndefined();
    expect(findTenantDoPayload(null)).toBeUndefined();
  });

  test("a fila usa o padrão quando key não é informada", async () => {
    const adapter = new InMemoryQueueAdapter();
    const emVoo = new Map<number, number>();
    const pico = new Map<number, number>();
    let concluidos = 0;
    registerQueue("iptu", adapter);
    registerProcessor("iptu", {
      concurrency: 10,
      pollMs: 5,
      perTenant: { concurrency: 1 },
      handler: async (payload: { ctx: { tenant: number } }) => {
        const tenant = payload.ctx.tenant;
        emVoo.set(tenant, (emVoo.get(tenant) ?? 0) + 1);
        pico.set(tenant, Math.max(pico.get(tenant) ?? 0, emVoo.get(tenant) ?? 0));
        await delay(10);
        emVoo.set(tenant, (emVoo.get(tenant) ?? 1) - 1);
        concluidos++;
      },
    });
    for (let n = 0; n < 4; n++) {
      adapter.create({
        id: `j${n}`,
        payload: { ctx: { tenant: n % 2 === 0 ? 10 : 12 } },
        status: "pending",
        createdAt: n,
      });
    }
    startProcessors();

    await waitUntil(() => concluidos === 4);

    expect(pico.get(10)).toBe(1);
    expect(pico.get(12)).toBe(1);
  });
});

describe("@Processor com perTenant", () => {
  test("repassa o perTenant ao registro", async () => {
    let emVoo = 0;
    let pico = 0;
    let concluidos = 0;

    class IptuWorker {
      @Processor("iptu", { concurrency: 10, pollMs: 5, perTenant: { concurrency: 2 } })
      async handle() {
        emVoo++;
        pico = Math.max(pico, emVoo);
        await delay(20);
        emVoo--;
        concluidos++;
      }
    }

    const adapter = new InMemoryQueueAdapter();
    registerQueue("iptu", adapter);
    for (let n = 0; n < 5; n++) {
      adapter.create({ id: `j${n}`, payload: { tenant: 4 }, status: "pending", createdAt: n });
    }
    initProcessors(new IptuWorker());

    await waitUntil(() => concluidos === 5);

    expect(pico).toBe(2);
  });

  test("concurrency do perTenant fora do padrão lança ao decorar", () => {
    expect(() => Processor("iptu", { perTenant: { concurrency: 0 } })).toThrow(RangeError);
    expect(() => Processor("iptu", { perTenant: { concurrency: 1.5 } })).toThrow(
      "[@mateusseiboth/ts-decorators] @Processor: perTenant.concurrency deve ser um inteiro maior ou igual a 1 (recebeu 1.5).",
    );
  });

  test("perTenant e keyOf juntos lançam ao decorar", () => {
    expect(() =>
      Processor("iptu", {
        keyOf: (payload) => payload.tenant,
        perTenant: { concurrency: 1 },
      }),
    ).toThrow("[@mateusseiboth/ts-decorators] @Processor: use perTenant ou keyOf, não os dois.");
  });

  test("registerProcessor valida do mesmo jeito", () => {
    expect(() =>
      registerProcessor("iptu", {
        handler: () => undefined,
        concurrency: 1,
        pollMs: 5,
        perTenant: { concurrency: -1 },
      }),
    ).toThrow(RangeError);
  });
});

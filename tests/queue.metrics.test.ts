import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import { setHandlerContext, type HandlerContext } from "../src/handlers/context";
import { BUCKETS_QUEUE } from "../src/observability/buckets";
import { registerDefaultMetrics } from "../src/observability/defaultMetrics";
import {
  clearQueues,
  enqueue,
  getInFlightCount,
  registerProcessor,
  registerQueue,
  startProcessors,
} from "../src/queue/registry";
import { SqliteQueueAdapter } from "../src/queue/SqliteQueueAdapter";
import { sortTextos, startColetor, type Coletor } from "./_metricas";

const host = new AsyncLocalStorage<HandlerContext>();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(isPronto: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const limite = Date.now() + timeoutMs;
  while (!(await isPronto())) {
    if (Date.now() > limite) throw new Error("A condição não foi atendida a tempo.");
    await delay(5);
  }
}

type Payload = { tenant?: number; ctx?: { tenant: number }; falhar?: boolean };

describe("métricas da fila", () => {
  let coletor: Coletor;
  let adapter: SqliteQueueAdapter<Payload>;
  let terminados = 0;

  beforeEach(() => {
    coletor = startColetor();
    setHandlerContext(() => host.getStore());
    adapter = new SqliteQueueAdapter<Payload>(":memory:", "remessas");
    terminados = 0;
    registerQueue("remessas", adapter);
    registerProcessor("remessas", {
      concurrency: 2,
      pollMs: 10,
      handler: async (payload: Payload) => {
        await delay(5);
        terminados++;
        if (payload.falhar) throw new Error("banco recusou");
      },
    });
  });
  afterEach(async () => {
    clearQueues();
    adapter.close();
    setHandlerContext(() => undefined);
    await coletor.stop();
  });

  test("enfileirado, espera, duração e término, com o tenant do job", async () => {
    await enqueue("remessas", { tenant: 79 });
    await enqueue("remessas", { ctx: { tenant: 12 }, falhar: true });
    // O tenant é a do payload, nos formatos dos apps: o contexto de quem enfileira não vale,
    // porque o consumidor roda fora dele e os rótulos do enfileirado e do terminado têm de casar.
    await host.run({ entity: 5 }, () => enqueue("remessas", {}));
    startProcessors();
    await waitUntil(() => terminados === 3 && getInFlightCount() === 0);
    await waitUntil(async () => (await coletor.points("queue.job.finished")).length === 3);

    expect(await coletor.points("queue.job.enqueued")).toEqual([
      { attributes: { queue: "remessas", tenant: "79" }, value: 1 },
      { attributes: { queue: "remessas", tenant: "12" }, value: 1 },
      { attributes: { queue: "remessas" }, value: 1 },
    ]);

    const finished = await coletor.points("queue.job.finished");
    expect(finished).toContainEqual({
      attributes: { queue: "remessas", outcome: "ok", tenant: "79" },
      value: 1,
    });
    expect(finished).toContainEqual({
      attributes: { queue: "remessas", outcome: "erro", tenant: "12" },
      value: 1,
    });
    expect(finished).toContainEqual({ attributes: { queue: "remessas", outcome: "ok" }, value: 1 });

    const duracoes = await coletor.histogram("queue.job.duration");
    expect(duracoes.reduce((total, ponto) => total + ponto.count, 0)).toBe(3);
    expect(duracoes[0]?.boundaries).toEqual(BUCKETS_QUEUE);
    expect((await coletor.find("queue.job.duration"))?.descriptor.unit).toBe("s");

    const esperas = await coletor.histogram("queue.job.wait.duration");
    expect(esperas.map((ponto) => ponto.attributes)).toContainEqual({
      queue: "remessas",
      tenant: "79",
    });
    expect(esperas.reduce((total, ponto) => total + ponto.count, 0)).toBe(3);
  });

  test("gauges: jobs por status e em execução (registerDefaultMetrics)", async () => {
    const dispose = registerDefaultMetrics({ runtime: false });
    try {
      await enqueue("remessas", { tenant: 1 });
      await enqueue("remessas", { tenant: 2 });

      const jobs = await coletor.points("queue.jobs");
      expect(jobs).toContainEqual({
        attributes: { queue: "remessas", status: "pending" },
        value: 2,
      });
      expect(jobs).toContainEqual({
        attributes: { queue: "remessas", status: "completed" },
        value: 0,
      });
      expect(sortTextos(jobs.map((ponto) => ponto.attributes.status))).toEqual([
        "completed",
        "failed",
        "pending",
        "processing",
      ]);
      expect(await coletor.points("queue.jobs.in_flight")).toEqual([
        { attributes: { queue: "remessas" }, value: 0 },
      ]);
    } finally {
      dispose();
    }
  });
});

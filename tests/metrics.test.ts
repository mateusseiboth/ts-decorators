import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import { setHandlerContext, type HandlerContext } from "../src/handlers/context";
import {
  BUCKETS_DB,
  BUCKETS_HTTP,
  BUCKETS_PADRAO,
  BUCKETS_QUEUE,
} from "../src/observability/buckets";
import {
  getTenantLabel,
  incrementMetric,
  recordMetric,
  registerGauge,
} from "../src/observability/metrics";
import { setOtelLoader } from "../src/observability/otelApi";
import { startColetor, type Coletor } from "./_metricas";

const host = new AsyncLocalStorage<HandlerContext>();

describe("buckets", () => {
  test("famílias da especificação", () => {
    expect(BUCKETS_HTTP).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.35, 0.5, 0.75, 1, 1.5, 2.5, 5, 7.5, 10,
      20, 30, 60,
    ]);
    expect(BUCKETS_DB[0]).toBe(0.0005);
    expect(BUCKETS_DB.at(-1)).toBe(10);
    expect(BUCKETS_QUEUE[0]).toBe(0.05);
    expect(BUCKETS_QUEUE.at(-1)).toBe(1800);
  });

  test("registro por instrumento", () => {
    expect(BUCKETS_PADRAO["http.server.request.duration"]).toEqual(BUCKETS_HTTP);
    expect(BUCKETS_PADRAO["app.method.duration"]).toEqual(BUCKETS_HTTP);
    expect(BUCKETS_PADRAO["db.client.operation.duration"]).toEqual(BUCKETS_DB);
    expect(BUCKETS_PADRAO["db.client.transaction.duration"]).toEqual(BUCKETS_DB);
    expect(BUCKETS_PADRAO["queue.job.duration"]).toEqual(BUCKETS_QUEUE);
    expect(BUCKETS_PADRAO["queue.job.wait.duration"]).toEqual(BUCKETS_QUEUE);
  });
});

describe("recordMetric, incrementMetric e registerGauge", () => {
  let coletor: Coletor;

  beforeEach(() => {
    coletor = startColetor();
    setHandlerContext(() => host.getStore());
  });
  afterEach(async () => {
    await coletor.stop();
    setHandlerContext(() => undefined);
    setOtelLoader();
  });

  test("histograma com unidade, atributos e os buckets padrão do instrumento", async () => {
    recordMetric({
      name: "app.method.duration",
      value: 0.2,
      unit: "s",
      attributes: { "code.function": "Folha.calcular" },
    });

    const metrica = await coletor.find("app.method.duration");
    expect(metrica?.descriptor.unit).toBe("s");
    const [ponto] = await coletor.histogram("app.method.duration");
    expect(ponto).toMatchObject({
      attributes: { "code.function": "Folha.calcular" },
      count: 1,
      sum: 0.2,
      boundaries: BUCKETS_HTTP,
    });
  });

  test("buckets próprios", async () => {
    recordMetric({ name: "app.lote.tamanho", value: 7, buckets: [1, 10, 100] });
    const [ponto] = await coletor.histogram("app.lote.tamanho");
    expect(ponto?.boundaries).toEqual([1, 10, 100]);
  });

  test("contador soma por atributos; value padrão 1", async () => {
    incrementMetric({ name: "app.boleto.emitido", attributes: { banco: "001" } });
    incrementMetric({ name: "app.boleto.emitido", attributes: { banco: "001" }, value: 2 });
    incrementMetric({ name: "app.boleto.emitido", attributes: { banco: "104" } });

    const pontos = await coletor.points("app.boleto.emitido");
    expect(pontos).toContainEqual({ attributes: { banco: "001" }, value: 3 });
    expect(pontos).toContainEqual({ attributes: { banco: "104" }, value: 1 });
  });

  test("gauge observa a cada coleta; o retorno de registerGauge desliga", async () => {
    let fila = 3;
    const unregister = registerGauge({
      name: "app.remessa.pendente",
      unit: "{remessa}",
      observe: () => fila,
    });
    expect(await coletor.points("app.remessa.pendente")).toEqual([{ attributes: {}, value: 3 }]);

    fila = 5;
    expect((await coletor.points("app.remessa.pendente"))[0]?.value).toBe(5);

    // Desligado, o callback não roda mais: o SDK guarda o último valor, e ele não muda.
    unregister();
    fila = 9;
    expect((await coletor.points("app.remessa.pendente"))[0]?.value).toBe(5);
  });

  test("gauge com vários pontos e callback assíncrono", async () => {
    const unregister = registerGauge({
      name: "app.lote.status",
      observe: async () => [
        { value: 2, attributes: { status: "aberto" } },
        { value: 9, attributes: { status: "fechado" } },
      ],
    });
    try {
      const pontos = await coletor.points("app.lote.status");
      expect(pontos).toContainEqual({ attributes: { status: "aberto" }, value: 2 });
      expect(pontos).toContainEqual({ attributes: { status: "fechado" }, value: 9 });
    } finally {
      unregister();
    }
  });

  test("gauge que lança não derruba a coleta", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const unregister = registerGauge({
      name: "app.quebrado",
      observe: () => {
        throw new Error("sonda quebrada");
      },
    });
    try {
      incrementMetric({ name: "app.vivo" });
      expect(await coletor.points("app.vivo")).toEqual([{ attributes: {}, value: 1 }]);
    } finally {
      unregister();
      errorSpy.mockRestore();
    }
  });

  test("getTenantLabel: o tenant do contexto em texto, ou nada", () => {
    expect(getTenantLabel()).toEqual({});
    expect(host.run({ entity: 79 }, () => getTenantLabel())).toEqual({ tenant: "79" });
    expect(host.run({ entity: "" }, () => getTenantLabel())).toEqual({});
    expect(host.run({ entity: 0 }, () => getTenantLabel())).toEqual({});
  });

  test("o instrumento é resolvido de novo quando o provider global muda", async () => {
    incrementMetric({ name: "app.troca" });
    expect(await coletor.points("app.troca")).toEqual([{ attributes: {}, value: 1 }]);

    const segundo = startColetor();
    try {
      incrementMetric({ name: "app.troca" });
      expect(await segundo.points("app.troca")).toEqual([{ attributes: {}, value: 1 }]);
      // O provider antigo não recebe mais nada.
      expect(await coletor.points("app.troca")).toEqual([{ attributes: {}, value: 1 }]);
    } finally {
      await segundo.stop();
    }
  });

  test("gauge registrado antes do SDK passa a observar quando o provider chega", async () => {
    await coletor.stop();
    const unregister = registerGauge({ name: "app.antes.do.sdk", observe: () => 1 });
    coletor = startColetor();
    try {
      // Qualquer gravação confere o provider; a coleta do gauge também já enxerga.
      incrementMetric({ name: "app.qualquer" });
      expect(await coletor.points("app.antes.do.sdk")).toEqual([{ attributes: {}, value: 1 }]);
    } finally {
      unregister();
    }
  });

  describe("sem o @opentelemetry/api instalado", () => {
    beforeEach(() =>
      setOtelLoader(() => {
        throw new Error("Cannot find module '@opentelemetry/api'");
      }),
    );

    test("tudo vira no-op", async () => {
      recordMetric({ name: "app.sem.api", value: 1 });
      incrementMetric({ name: "app.sem.api.total" });
      const unregister = registerGauge({ name: "app.sem.api.gauge", observe: () => 1 });
      unregister();
      expect(await coletor.collect()).toEqual([]);
    });
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import { Counted } from "../src/decorators/counted";
import { Timed, clearTimings, getTimings } from "../src/decorators/timed";
import { setHandlerContext, type HandlerContext } from "../src/handlers/context";
import { BUCKETS_HTTP } from "../src/observability/buckets";
import { setOtelLoader } from "../src/observability/otelApi";
import { startColetor, type Coletor } from "./_metricas";

const host = new AsyncLocalStorage<HandlerContext>();

describe("@Timed e @Counted no OpenTelemetry", () => {
  let coletor: Coletor;

  beforeEach(() => {
    coletor = startColetor();
    clearTimings();
    setHandlerContext(() => host.getStore());
  });
  afterEach(async () => {
    await coletor.stop();
    setHandlerContext(() => undefined);
    setOtelLoader();
  });

  test("@Timed grava app.method.duration em segundos, com code.function, outcome e tenant", async () => {
    class FolhaService {
      @Timed()
      async calcularFolha() {
        await Bun.sleep(5);
        return "ok";
      }
    }

    await host.run({ entity: 79 }, () => new FolhaService().calcularFolha());

    const metrica = await coletor.find("app.method.duration");
    expect(metrica?.descriptor.unit).toBe("s");
    const [ponto] = await coletor.histogram("app.method.duration");
    expect(ponto?.attributes).toEqual({
      "code.function": "FolhaService.calcularFolha",
      outcome: "ok",
      tenant: "79",
    });
    expect(ponto?.count).toBe(1);
    expect(ponto?.sum).toBeGreaterThan(0.003);
    expect(ponto?.sum).toBeLessThan(1);
    expect(ponto?.boundaries).toEqual(BUCKETS_HTTP);
    // As estatísticas em memória continuam como antes.
    expect(getTimings()[0]).toMatchObject({ name: "FolhaService.calcularFolha", count: 1 });
  });

  test("erro: outcome erro e o mesmo erro relançado", async () => {
    class Remessa {
      @Timed()
      async sendLote() {
        throw new TypeError("recusado");
      }

      @Timed()
      validar() {
        throw new Error("síncrono");
      }
    }

    await expect(new Remessa().sendLote()).rejects.toBeInstanceOf(TypeError);
    expect(() => new Remessa().validar()).toThrow("síncrono");

    const pontos = await coletor.histogram("app.method.duration");
    expect(pontos.map((ponto) => ponto.attributes)).toEqual([
      { "code.function": "Remessa.sendLote", outcome: "erro" },
      { "code.function": "Remessa.validar", outcome: "erro" },
    ]);
  });

  test("name troca o code.function; labels saem dos argumentos; tenant: false tira o rótulo", async () => {
    class Iptu {
      @Timed({
        name: "iptu.lancamento",
        labels: (tipo: string) => ({ tipo }),
        tenant: false,
      })
      lancar(_tipo: string) {
        return 1;
      }
    }

    host.run({ entity: 79 }, () => new Iptu().lancar("predial"));

    const [ponto] = await coletor.histogram("app.method.duration");
    expect(ponto?.attributes).toEqual({
      "code.function": "iptu.lancamento",
      outcome: "ok",
      tipo: "predial",
    });
    expect(getTimings()[0]?.name).toBe("iptu.lancamento");
  });

  test("labels que lançam não derrubam a chamada: o ponto sai sem eles", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    class Calculo {
      @Timed({
        labels: () => {
          throw new Error("rótulo quebrado");
        },
      })
      calcular() {
        return 42;
      }
    }

    try {
      expect(new Calculo().calcular()).toBe(42);
    } finally {
      errorSpy.mockRestore();
    }
    const [ponto] = await coletor.histogram("app.method.duration");
    expect(ponto?.attributes).toEqual({ "code.function": "Calculo.calcular", outcome: "ok" });
  });

  test("buckets próprios pedem um instrumento próprio (metric)", async () => {
    class Lote {
      @Timed({ metric: "app.lote.duration", buckets: [1, 60, 600] })
      processar() {
        return true;
      }
    }

    new Lote().processar();
    const [ponto] = await coletor.histogram("app.lote.duration");
    expect(ponto?.boundaries).toEqual([1, 60, 600]);
    expect(await coletor.find("app.method.duration")).toBeUndefined();
  });

  test("buckets sem metric falha na declaração", () => {
    expect(() => Timed({ buckets: [1, 2] })).toThrow(TypeError);
  });

  test("@Counted conta as chamadas em app.method.calls, por outcome", async () => {
    class Webhook {
      @Counted({ labels: (origem: string) => ({ origem }) })
      async receber(origem: string) {
        if (origem === "erro") throw new Error("falhou");
        return origem;
      }
    }

    const webhook = new Webhook();
    await host.run({ entity: 12 }, async () => {
      await webhook.receber("banco");
      await webhook.receber("banco");
      await webhook.receber("erro").catch(() => undefined);
    });

    const metrica = await coletor.find("app.method.calls");
    expect(metrica?.descriptor.unit).toBe("{call}");
    const pontos = await coletor.points("app.method.calls");
    expect(pontos).toContainEqual({
      attributes: {
        "code.function": "Webhook.receber",
        outcome: "ok",
        origem: "banco",
        tenant: "12",
      },
      value: 2,
    });
    expect(pontos).toContainEqual({
      attributes: {
        "code.function": "Webhook.receber",
        outcome: "erro",
        origem: "erro",
        tenant: "12",
      },
      value: 1,
    });
  });

  test("@Counted mantém o método síncrono síncrono, e aceita metric e name", async () => {
    class Calculo {
      @Counted({ name: "calculo.somar", metric: "app.calculo.calls", tenant: false })
      somar(a: number, b: number) {
        return a + b;
      }
    }

    expect(new Calculo().somar(1, 2)).toBe(3);
    expect(await coletor.points("app.calculo.calls")).toEqual([
      { attributes: { "code.function": "calculo.somar", outcome: "ok" }, value: 1 },
    ]);
  });

  describe("sem o @opentelemetry/api instalado", () => {
    beforeEach(() =>
      setOtelLoader(() => {
        throw new Error("Cannot find module '@opentelemetry/api'");
      }),
    );

    test("os decorators só chamam o método; o @Timed segue com as estatísticas", async () => {
      class Servico {
        @Timed()
        @Counted()
        async rodar() {
          return "rodou";
        }
      }

      expect(await new Servico().rodar()).toBe("rodou");
      expect(getTimings()[0]?.count).toBe(1);
      expect(await coletor.collect()).toEqual([]);
    });
  });
});

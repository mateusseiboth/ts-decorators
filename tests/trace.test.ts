import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace";

import { Trace, setOtelLoader, withSpan } from "../src/decorators/trace";
import { setHandlerContext, type HandlerContext } from "../src/handlers/context";
import { captureWarnings } from "./_helpers";

/** Guarda cada span na hora em que ele termina (o `SimpleSpanProcessor` exporta depois). */
const terminados: ReadableSpan[] = [];
const recorder: SpanProcessor = {
  onStart: () => {},
  onEnd: (span) => {
    terminados.push(span);
  },
  forceFlush: async () => {},
  shutdown: async () => {},
};
const contextManager = new AsyncLocalStorageContextManager();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const findSpan = (name: string): ReadableSpan | undefined =>
  terminados.find((span) => span.name === name);

const requireSpan = (name: string): ReadableSpan => {
  const span = findSpan(name);
  if (!span) throw new Error(`Span ${name} não terminou.`);
  return span;
};

const host = new AsyncLocalStorage<HandlerContext>();

describe("@Trace e withSpan", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
    trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [recorder] }));
  });
  afterAll(() => {
    trace.disable();
    context.disable();
  });
  beforeEach(() => {
    terminados.length = 0;
    warnCap = captureWarnings();
    setHandlerContext(() => host.getStore());
  });
  afterEach(() => {
    warnCap.restore();
    setHandlerContext(() => undefined);
    setOtelLoader();
  });

  test("o span leva o nome Classe.metodo e devolve o retorno do método", async () => {
    class FolhaService {
      @Trace()
      async calcularFolha(competencia: string) {
        return `folha ${competencia}`;
      }
    }

    expect(await new FolhaService().calcularFolha("2026-10")).toBe("folha 2026-10");
    expect(requireSpan("FolhaService.calcularFolha").status.code).toBe(SpanStatusCode.UNSET);
  });

  test("a opção name troca o nome do span", () => {
    class Remessa {
      @Trace({ name: "remessa.sendLote" })
      sendLote() {
        return 1;
      }
    }
    new Remessa().sendLote();
    expect(findSpan("remessa.sendLote")).toBeDefined();
  });

  test("atributos: a entidade do contexto e os que vêm dos argumentos", () => {
    class ImovelService {
      @Trace({
        attributes: (inscricao: string, ano: number) => ({ inscricao, ano, urgente: true }),
      })
      calcularIptu(_inscricao: string, _ano: number) {
        return 0;
      }
    }

    host.run({ entity: 79 }, () => new ImovelService().calcularIptu("01.02.003", 2026));
    expect(requireSpan("ImovelService.calcularIptu").attributes).toEqual({
      "app.entity": 79,
      inscricao: "01.02.003",
      ano: 2026,
      urgente: true,
    });
  });

  test("sem entidade no contexto, o atributo não entra", () => {
    withSpan("sem.contexto", () => 1);
    expect(requireSpan("sem.contexto").attributes).toEqual({});
  });

  test("atributos que lançam não derrubam a chamada", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    class Calculo {
      @Trace({
        attributes: () => {
          throw new Error("atributo quebrado");
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
    expect(requireSpan("Calculo.calcular").attributes).toEqual({});
  });

  test("erro: recordException, status ERROR e o mesmo erro relançado", async () => {
    class EsocialClient {
      @Trace()
      async sendEvento() {
        await sleep(1);
        throw new TypeError("lote recusado");
      }
    }

    const erro = await new EsocialClient().sendEvento().catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(TypeError);

    const span = requireSpan("EsocialClient.sendEvento");
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "lote recusado" });
    expect(span.events.map((evento) => evento.name)).toEqual(["exception"]);
    expect(span.events[0]?.attributes?.["exception.message"]).toBe("lote recusado");
  });

  test("erro síncrono também é registrado e relançado", () => {
    expect(() =>
      withSpan("sincrono.falha", () => {
        throw new Error("falhou");
      }),
    ).toThrow("falhou");
    expect(requireSpan("sincrono.falha").status.code).toBe(SpanStatusCode.ERROR);
  });

  test("método assíncrono: o span só fecha quando a promessa termina", async () => {
    let liberar = () => {};
    const espera = new Promise<void>((resolve) => {
      liberar = resolve;
    });

    class Fila {
      @Trace()
      async drain() {
        await espera;
        return "ok";
      }
    }

    const chamada = new Fila().drain();
    await sleep(2);
    expect(findSpan("Fila.drain")).toBeUndefined();

    liberar();
    expect(await chamada).toBe("ok");
    expect(findSpan("Fila.drain")).toBeDefined();
  });

  test("método síncrono continua síncrono", () => {
    class Calculo {
      @Trace()
      somar(a: number, b: number) {
        return a + b;
      }
    }
    expect(new Calculo().somar(1, 2)).toBe(3);
  });

  test("chamadas aninhadas em código assíncrono viram pai e filho", async () => {
    class Dao {
      @Trace()
      async findParcelas() {
        await sleep(1);
        return [1, 2];
      }
    }
    const dao = new Dao();

    class CarneService {
      @Trace()
      async buildCarne() {
        await sleep(1);
        const [parcelas] = await Promise.all([dao.findParcelas(), sleep(1)]);
        return withSpan("carne.render", async () => parcelas.length, {
          attributes: { modelo: "a4" },
        });
      }
    }

    expect(await new CarneService().buildCarne()).toBe(2);

    const pai = requireSpan("CarneService.buildCarne");
    const filho = requireSpan("Dao.findParcelas");
    const render = requireSpan("carne.render");
    expect(filho.parentSpanContext?.spanId).toBe(pai.spanContext().spanId);
    expect(render.parentSpanContext?.spanId).toBe(pai.spanContext().spanId);
    expect(filho.spanContext().traceId).toBe(pai.spanContext().traceId);
    expect(render.attributes).toEqual({ modelo: "a4" });
  });

  describe("sem o @opentelemetry/api instalado", () => {
    beforeEach(() =>
      setOtelLoader(() => {
        throw new Error("Cannot find module '@opentelemetry/api'");
      }),
    );

    test("o decorator não faz nada: o método roda e devolve o retorno", async () => {
      class FolhaService {
        @Trace()
        async calcularFolha() {
          return "ok";
        }

        @Trace()
        somar(a: number, b: number) {
          return a + b;
        }
      }

      expect(await new FolhaService().calcularFolha()).toBe("ok");
      expect(new FolhaService().somar(2, 3)).toBe(5);
      expect(withSpan("nada", () => "rodou")).toBe("rodou");
      expect(terminados).toHaveLength(0);
    });

    test("o erro do método continua chegando a quem chamou", () => {
      expect(() =>
        withSpan("nada", () => {
          throw new Error("falhou");
        }),
      ).toThrow("falhou");
    });
  });
});

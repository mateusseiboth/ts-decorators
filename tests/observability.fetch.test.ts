import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import { SpanKind, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";

import { setHandlerContext, type HandlerContext } from "../src/handlers/context";
import { instrumentFetch } from "../src/observability/fetch";
import { buildTextMapPropagator } from "../src/observability/propagation";

const terminados: ReadableSpan[] = [];
const medicoes: Array<{ valor: number; rotulos: Record<string, unknown> }> = [];

const fakeMeter = {
  createHistogram: () => ({
    record: (valor: number, rotulos: Record<string, unknown> = {}) =>
      void medicoes.push({ valor, rotulos }),
  }),
} as any;

const host = new AsyncLocalStorage<HandlerContext>();
const tracer = () => trace.getTracer("teste");

let servidor: ReturnType<typeof Bun.serve>;
let base = "";
let fetchOriginal: typeof fetch;
let restore: () => void = () => {};

const readEco = async (resposta: Response) =>
  (await resposta.json()) as { headers: Record<string, string> };

describe("fetch instrumentado", () => {
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(buildTextMapPropagator());
    trace.setGlobalTracerProvider(
      new TracerProvider({
        spanProcessors: [
          {
            onStart: () => {},
            onEnd: (span) => void terminados.push(span),
            forceFlush: async () => {},
            shutdown: async () => {},
          },
        ],
      }),
    );
    servidor = Bun.serve({
      port: 0,
      fetch: (req) => {
        const status = Number(new URL(req.url).searchParams.get("status") ?? 200);
        return Response.json({ headers: Object.fromEntries(req.headers) }, { status });
      },
    });
    base = `http://127.0.0.1:${servidor.port}`;
    fetchOriginal = globalThis.fetch;
  });
  afterAll(() => {
    void servidor.stop(true);
    trace.disable();
    propagation.disable();
    context.disable();
  });
  beforeEach(() => {
    terminados.length = 0;
    medicoes.length = 0;
    setHandlerContext(() => host.getStore());
    restore = instrumentFetch({
      tracer: tracer(),
      meter: fakeMeter,
      ignoreUrl: (url) => url.pathname === "/ignorado",
    });
  });
  afterEach(() => {
    restore();
    setHandlerContext(() => undefined);
  });

  test("injeta traceparent, X-Trace-Id e x-request-id e abre um span CLIENT filho", async () => {
    const { traceId, eco } = await host.run({ requestId: "req-1" }, () =>
      tracer().startActiveSpan("pai", async (pai) => {
        const resposta = await fetch(`${base}/eco?q=1`);
        pai.end();
        return { traceId: pai.spanContext().traceId, eco: await readEco(resposta) };
      }),
    );

    expect(eco.headers.traceparent).toStartWith(`00-${traceId}-`);
    expect(eco.headers["x-trace-id"]).toBe(traceId);
    expect(eco.headers["x-request-id"]).toBe("req-1");

    const cliente = terminados.find((span) => span.kind === SpanKind.CLIENT)!;
    expect(cliente.name).toBe("GET");
    expect(cliente.spanContext().traceId).toBe(traceId);
    expect(cliente.attributes).toMatchObject({
      "http.request.method": "GET",
      "server.address": "127.0.0.1",
      "server.port": servidor.port,
      "http.response.status_code": 200,
    });
  });

  test("registra http.client.request.duration em segundos, com rótulos de baixa cardinalidade", async () => {
    await fetch(`${base}/eco`, { method: "post", body: "{}" });

    expect(medicoes).toHaveLength(1);
    expect(medicoes[0]!.valor).toBeLessThan(5);
    expect(medicoes[0]!.rotulos).toEqual({
      "http.request.method": "POST",
      "server.address": "127.0.0.1",
      "http.response.status_code": 200,
    });
  });

  test("o x-request-id que o chamador já mandou é mantido", async () => {
    const eco = await host.run({ requestId: "req-2" }, async () =>
      readEco(await fetch(`${base}/eco`, { headers: { "x-request-id": "do-chamador" } })),
    );
    expect(eco.headers["x-request-id"]).toBe("do-chamador");
  });

  test("Request como entrada também recebe os headers", async () => {
    const eco = await host.run({ requestId: "req-3" }, async () =>
      readEco(await fetch(new Request(`${base}/eco`, { headers: { accept: "application/json" } }))),
    );
    expect(eco.headers["x-request-id"]).toBe("req-3");
    expect(eco.headers.accept).toBe("application/json");
  });

  test("resposta 5xx marca o span com erro", async () => {
    await fetch(`${base}/eco?status=503`);
    const cliente = terminados.find((span) => span.kind === SpanKind.CLIENT)!;
    expect(cliente.status.code).toBe(SpanStatusCode.ERROR);
  });

  test("falha de rede marca o span com erro e relança", async () => {
    const fechado = Bun.serve({ port: 0, fetch: () => new Response("") });
    const url = `http://127.0.0.1:${fechado.port}/x`;
    await fechado.stop(true);

    await expect(fetch(url)).rejects.toThrow();
    const cliente = terminados.find((span) => span.kind === SpanKind.CLIENT)!;
    expect(cliente.status.code).toBe(SpanStatusCode.ERROR);
    expect(medicoes[0]!.rotulos["http.response.status_code"]).toBeUndefined();
  });

  test("URL ignorada (o endpoint OTLP) passa direto, sem span e sem header", async () => {
    const eco = await readEco(await fetch(`${base}/ignorado`));
    expect(eco.headers.traceparent).toBeUndefined();
    expect(terminados).toHaveLength(0);
  });

  test("credenciais e query sensível não entram na URL do span", async () => {
    await fetch(`${base}/eco?token=abc&pagina=2`);
    const cliente = terminados.find((span) => span.kind === SpanKind.CLIENT)!;
    expect(cliente.attributes["url.full"]).toBe(`${base}/eco?token=%5Bredacted%5D&pagina=2`);
  });

  test("restore devolve o fetch original, e instrumentar duas vezes não empilha", () => {
    const segunda = instrumentFetch({ tracer: tracer(), meter: fakeMeter });
    segunda();
    restore();
    expect(globalThis.fetch).toBe(fetchOriginal);
  });
});

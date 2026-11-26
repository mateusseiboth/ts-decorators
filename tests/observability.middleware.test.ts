/**
 * `observeHttp` dentro do processo, com um span de servidor feito à mão no lugar do que a
 * instrumentation-http abre (o teste com o SDK de verdade, no preload, é o de integração).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "node:http";

import { SpanKind, SpanStatusCode, context, metrics, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  MeterProvider,
  MetricReader,
  type DataPoint,
  type Histogram,
} from "@opentelemetry/sdk-metrics";
import { TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";
import express, { type NextFunction, type Request, type Response } from "express";

import { configureLogger, logger, resetLogger, setLogWriter } from "../src/functions/logger";
import { setHandlerContext, type HandlerContext } from "../src/handlers/context";
import { markBodyCapture } from "../src/observability/bodyCapture";
import { isIgnoredRequest, setIgnoredPaths } from "../src/observability/httpAttributes";
import { observeHttp, type ObserveHttpOptions } from "../src/observability/httpMiddleware";
import { buildTextMapPropagator } from "../src/observability/propagation";
import { saveServerSpan } from "../src/observability/serverSpan";

class LeitorDeTeste extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

const terminados: ReadableSpan[] = [];
const linhas: Array<Record<string, any>> = [];
const leitor = new LeitorDeTeste();
const host = new AsyncLocalStorage<HandlerContext>();
const tracer = () => trace.getTracer("teste");

/** O que a instrumentation-http faz: abre o span SERVER e o guarda para o middleware achar. */
const openServerSpan = (req: Request, res: Response, next: NextFunction) => {
  const span = tracer().startSpan(req.method, { kind: SpanKind.SERVER });
  saveServerSpan(req, span);
  res.once("close", () => setImmediate(() => span.end()));
  context.with(trace.setSpan(context.active(), span), next);
};

let servidor: Server;
let base = "";

/** `instrumentado: false` é o projeto em que a instrumentation-http não abriu o span. */
const startApp = async (
  options?: ObserveHttpOptions,
  antes?: express.RequestHandler,
  { instrumentado = true } = {},
) => {
  const app = express();
  if (instrumentado) app.use(openServerSpan);
  if (antes) app.use(antes);
  app.use(express.json({ limit: "5mb" }));
  app.use(observeHttp(options));
  const imoveis = express.Router();
  imoveis.get("/:id", (req, res) => {
    logger.info("lendo imóvel");
    res.json({ id: req.params.id });
  });
  imoveis.post("/", (req, res) => {
    markBodyCapture(req);
    res.status(201).json({ id: "novo", senha: "segredo", eco: req.body });
  });
  imoveis.get("/:id/pdf", (req, res) => {
    markBodyCapture(req);
    res.type("application/pdf").send(Buffer.from("%PDF"));
  });
  app.use("/api/imoveis", imoveis);
  app.get("/quebra", () => {
    throw new Error("falhou");
  });
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/contexto", (_req, res) => res.json({ ok: true }));
  app.get("/filho", (_req, res) => {
    tracer().startActiveSpan("consulta", (span) => {
      span.end();
      logger.info("no filho");
      res.json({ ok: true });
    });
  });
  servidor = app.listen(0);
  await new Promise((resolve) => servidor.once("listening", resolve));
  base = `http://127.0.0.1:${(servidor.address() as { port: number }).port}`;
};

const stopApp = () => new Promise((resolve) => servidor.close(resolve));

/** Espera o `close` da resposta e o `setImmediate` que fecha o span. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const findServerSpan = () => terminados.find((span) => span.kind === SpanKind.SERVER)!;

const readPontos = async (nome: string) => {
  const { resourceMetrics } = await leitor.collect();
  const metrica = resourceMetrics.scopeMetrics
    .flatMap((escopo) => escopo.metrics)
    .find((m) => m.descriptor.name === nome);
  return metrica?.dataPoints ?? [];
};

const readHistograma = async (nome: string) => (await readPontos(nome)) as DataPoint<Histogram>[];

describe("observeHttp", () => {
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
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [leitor] }));
  });
  afterAll(() => {
    trace.disable();
    metrics.disable();
    propagation.disable();
    context.disable();
  });
  beforeEach(() => {
    terminados.length = 0;
    linhas.length = 0;
    setLogWriter((linha) => void linhas.push(JSON.parse(linha)));
    configureLogger({ service: "api", env: "production", format: "json", level: "info" });
  });
  afterEach(async () => {
    await stopApp();
    setLogWriter();
    resetLogger();
    setHandlerContext(() => undefined);
  });

  test("enriquece o span SERVER que já existe: rota, nome, request id e headers mascarados", async () => {
    await startApp();
    const resposta = await fetch(`${base}/api/imoveis/7?x=1`, {
      headers: { authorization: "Bearer segredo", accept: "application/json" },
    });
    await settle();

    expect(terminados.filter((span) => span.kind === SpanKind.SERVER)).toHaveLength(1);
    const span = findServerSpan();
    expect(span.name).toBe("GET /api/imoveis/:id");
    expect(span.attributes).toMatchObject({
      "http.route": "/api/imoveis/:id",
      "app.request_id": resposta.headers.get("x-request-id"),
      "http.request.header.authorization": "[redacted]",
      "http.request.header.accept": "application/json",
    });
    expect(resposta.headers.get("x-trace-id")).toBe(span.spanContext().traceId);
    expect(resposta.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("o x-request-id que chegou é mantido e devolvido", async () => {
    await startApp();
    const resposta = await fetch(`${base}/api/imoveis/7`, { headers: { "x-request-id": "gw-1" } });
    await settle();
    expect(resposta.headers.get("x-request-id")).toBe("gw-1");
    expect(findServerSpan().attributes["app.request_id"]).toBe("gw-1");
  });

  test("o logger dentro do handler sai com request_id e trace_id, sem setHandlerContext", async () => {
    await startApp();
    const resposta = await fetch(`${base}/api/imoveis/7`);
    await settle();
    const linha = linhas.find((l) => l.msg === "lendo imóvel")!;
    expect(linha.request_id).toBe(resposta.headers.get("x-request-id")!);
    expect(linha.trace_id).toBe(findServerSpan().spanContext().traceId);
  });

  test("tenant, usuário e request id vêm do contexto do handler quando ele existe", async () => {
    setHandlerContext(() => host.getStore());
    const openContexto: express.RequestHandler = (_req, _res, next) =>
      host.run({ requestId: "ctx-1", entity: 79, user: { id: "u-9" } }, next);
    await startApp(undefined, openContexto);
    const resposta = await fetch(`${base}/contexto`);
    await settle();

    expect(resposta.headers.get("x-request-id")).toBe("ctx-1");
    expect(findServerSpan().attributes).toMatchObject({
      tenant: 79,
      "enduser.id": "u-9",
      "app.request_id": "ctx-1",
    });
    const acesso = linhas.find((l) => l.msg === "http")!;
    expect(acesso).toMatchObject({ request_id: "ctx-1", tenant: 79, user_id: "u-9" });
  });

  test("sem rota casada: (sem rota), nunca o path cru", async () => {
    await startApp();
    await fetch(`${base}/nao/existe/123`);
    await settle();
    expect(findServerSpan().attributes["http.route"]).toBe("(sem rota)");
    const pontos = await readHistograma("http.server.request.duration");
    expect(pontos.some((p) => p.attributes["http.route"] === "/nao/existe/123")).toBe(false);
  });

  test("5xx marca o span com erro e o log de acesso sai como error", async () => {
    await startApp();
    await fetch(`${base}/quebra`);
    await settle();
    expect(findServerSpan().status.code).toBe(SpanStatusCode.ERROR);
    expect(linhas.find((l) => l.msg === "http")).toMatchObject({ level: "error", status: 500 });
  });

  test("uma linha de acesso por requisição, com o que o Loki precisa", async () => {
    await startApp();
    await fetch(`${base}/api/imoveis/7`);
    await settle();
    const acessos = linhas.filter((l) => l.msg === "http");
    expect(acessos).toHaveLength(1);
    expect(acessos[0]).toMatchObject({
      level: "info",
      method: "GET",
      route: "/api/imoveis/:id",
      status: 200,
      bytes_out: 10,
      trace_id: findServerSpan().spanContext().traceId,
    });
    expect(typeof acessos[0]!.duration_ms).toBe("number");
  });

  test("accessLog: false desliga a linha de acesso", async () => {
    await startApp({ accessLog: false });
    await fetch(`${base}/api/imoveis/7`);
    await settle();
    expect(linhas.filter((l) => l.msg === "http")).toHaveLength(0);
  });

  test("/health fica fora: sem log de acesso e sem métrica", async () => {
    await startApp();
    await fetch(`${base}/health`);
    await settle();
    expect(linhas.filter((l) => l.msg === "http")).toHaveLength(0);
    const pontos = await readHistograma("http.server.request.duration");
    expect(pontos.some((p) => String(p.attributes["http.route"]).includes("health"))).toBe(false);
  });

  test("corpo fica fora do span quando a requisição não foi marcada", async () => {
    await startApp();
    await fetch(`${base}/api/imoveis/7`);
    await settle();
    expect(findServerSpan().attributes["http.request.body"]).toBeUndefined();
    expect(findServerSpan().attributes["http.response.body"]).toBeUndefined();
  });

  test("requisição marcada leva os dois corpos INTEIROS, credenciais mascaradas", async () => {
    await startApp();
    const texto = "a".repeat(40_000);
    await fetch(`${base}/api/imoveis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto, password: "p" }),
    });
    await settle();
    const atributos = findServerSpan().attributes;
    const pedido = JSON.parse(String(atributos["http.request.body"]));
    const resposta = JSON.parse(String(atributos["http.response.body"]));
    expect(pedido).toEqual({ texto, password: "[redacted]" });
    expect(resposta).toEqual({
      id: "novo",
      senha: "[redacted]",
      eco: { texto, password: "[redacted]" },
    });
  });

  test("maxBodyBytes é o teto por atributo", async () => {
    await startApp({ maxBodyBytes: 1024 });
    await fetch(`${base}/api/imoveis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto: "a".repeat(5000) }),
    });
    await settle();
    expect(String(findServerSpan().attributes["http.request.body"])).toContain("[truncado:");
  });

  test("resposta binária marcada não entra no span", async () => {
    await startApp();
    await fetch(`${base}/api/imoveis/7/pdf`);
    await settle();
    expect(findServerSpan().attributes["http.response.body"]).toBe("[omitido: binário/stream]");
  });

  test("métricas HTTP: duração com tenant, requisições ativas e tamanhos", async () => {
    setHandlerContext(() => host.getStore());
    const openContexto: express.RequestHandler = (_req, _res, next) =>
      host.run({ requestId: "m-1", entity: 12 }, next);
    await startApp(undefined, openContexto);
    await fetch(`${base}/api/imoveis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    await settle();

    const duracao = await readHistograma("http.server.request.duration");
    // O histograma é cumulativo entre os testes: o ponto desta requisição é o que tem o tenant.
    const ponto = duracao.find((p) => p.attributes.tenant === 12);
    expect(ponto?.attributes).toEqual({
      "http.request.method": "POST",
      "http.route": "/api/imoveis",
      "http.response.status_code": 201,
      tenant: 12,
    });
    expect(ponto!.value.count).toBeGreaterThanOrEqual(1);

    const ativas = await readPontos("http.server.active_requests");
    expect(ativas.find((p) => p.attributes["http.request.method"] === "POST")?.value).toBe(0);

    const entrada = await readHistograma("http.server.request.body.size");
    // Cumulativo: o menor corpo POST dos testes é o `{"a":1}` desta requisição.
    expect(entrada.find((p) => p.attributes["http.route"] === "/api/imoveis")?.value.min).toBe(7);
    const saida = await readHistograma("http.server.response.body.size");
    expect(saida.find((p) => p.attributes["http.route"] === "/api/imoveis")).toBeDefined();
  });
  describe("rota de router aninhado quando o erro chega ao handler global", () => {
    const MODULOS = ["contratos", "convenios"] as const;

    const failRequest: express.RequestHandler = () => {
      throw new Error("bloqueado no middleware da rota");
    };

    /** Um módulo do jeito do portal: prefixo fixo e as rotas por tenant dentro do router. */
    const buildModulo = (withObservacao: boolean) => {
      const modulo = express.Router();
      if (withObservacao) modulo.use(observeHttp());
      modulo.get("/:tenant/itens/:id", (req, res) => res.json({ path: req.route.path }));
      modulo.get("/:tenant/falha/:id", () => {
        throw new Error("falhou no handler");
      });
      modulo.get("/:tenant/negado/:id", failRequest, (_req, res) => res.json({ ok: true }));
      return modulo;
    };

    /** O `req.route` lido no handler global de erro: o app continua enxergando a rota casada. */
    const onError = (_erro: unknown, req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ path: req.route?.path });
    };

    /** `insideRouter: true` monta o `observeHttp` dentro do router do módulo, não no app. */
    const startModulos = async ({ insideRouter = false } = {}) => {
      const app = express();
      app.use(openServerSpan);
      if (!insideRouter) app.use(observeHttp());
      for (const modulo of MODULOS) app.use(`/api/v1/${modulo}`, buildModulo(insideRouter));
      app.use(onError);
      servidor = app.listen(0);
      await new Promise((resolve) => servidor.once("listening", resolve));
      base = `http://127.0.0.1:${(servidor.address() as { port: number }).port}`;
    };

    const findAcesso = () => linhas.find((l) => l.msg === "http")!;

    const findPontoDaRota = async (rota: string, status: number) =>
      (await readHistograma("http.server.request.duration")).find(
        (p) =>
          p.attributes["http.route"] === rota &&
          p.attributes["http.response.status_code"] === status,
      );

    test("erro no handler: a rota leva o prefixo do módulo no span, na métrica e no log", async () => {
      await startModulos();
      const resposta = await fetch(`${base}/api/v1/contratos/79/falha/5`);
      await settle();

      const rota = "/api/v1/contratos/:tenant/falha/:id";
      expect(resposta.status).toBe(500);
      expect(findServerSpan().name).toBe(`GET ${rota}`);
      expect(findServerSpan().attributes["http.route"]).toBe(rota);
      expect(findAcesso()).toMatchObject({ route: rota, status: 500 });
      expect(await findPontoDaRota(rota, 500)).toBeDefined();
      expect(await findPontoDaRota("/:tenant/falha/:id", 500)).toBeUndefined();
    });

    test("erro no middleware da rota, antes do handler: mesma rota completa", async () => {
      await startModulos();
      await fetch(`${base}/api/v1/contratos/79/negado/5`);
      await settle();

      const rota = "/api/v1/contratos/:tenant/negado/:id";
      expect(findServerSpan().name).toBe(`GET ${rota}`);
      expect(findAcesso()).toMatchObject({ route: rota, status: 500 });
      expect(await findPontoDaRota(rota, 500)).toBeDefined();
    });

    test("módulos com o mesmo caminho interno não se misturam na rota", async () => {
      await startModulos();
      await fetch(`${base}/api/v1/contratos/79/falha/5`);
      await fetch(`${base}/api/v1/convenios/79/falha/5`);
      await settle();

      const rotas = linhas.filter((l) => l.msg === "http").map((l) => l.route);
      expect(rotas).toEqual([
        "/api/v1/contratos/:tenant/falha/:id",
        "/api/v1/convenios/:tenant/falha/:id",
      ]);
    });

    test("sucesso continua com a rota completa", async () => {
      await startModulos();
      await fetch(`${base}/api/v1/convenios/79/itens/5`);
      await settle();

      const rota = "/api/v1/convenios/:tenant/itens/:id";
      expect(findServerSpan().name).toBe(`GET ${rota}`);
      expect(findAcesso()).toMatchObject({ route: rota, status: 200 });
      expect(await findPontoDaRota(rota, 200)).toBeDefined();
    });

    test("caminho que não casa com rota nenhuma: (sem rota)", async () => {
      await startModulos();
      await fetch(`${base}/api/v1/contratos/79/nada`);
      await settle();

      expect(findServerSpan().attributes["http.route"]).toBe("(sem rota)");
      expect(findAcesso()).toMatchObject({ route: "(sem rota)", status: 404 });
    });

    test("o app continua lendo req.route no handler e no handler global de erro", async () => {
      await startModulos();
      const sucesso = await fetch(`${base}/api/v1/contratos/79/itens/5`);
      const falha = await fetch(`${base}/api/v1/contratos/79/falha/5`);
      await settle();

      expect(await sucesso.json()).toEqual({ path: "/:tenant/itens/:id" });
      expect(await falha.json()).toEqual({ path: "/:tenant/falha/:id" });
    });

    test("observeHttp montado dentro do router do módulo: mesma rota completa no erro", async () => {
      await startModulos({ insideRouter: true });
      await fetch(`${base}/api/v1/convenios/79/falha/5`);
      await settle();

      const rota = "/api/v1/convenios/:tenant/falha/:id";
      expect(findServerSpan().name).toBe(`GET ${rota}`);
      expect(findAcesso()).toMatchObject({ route: rota, status: 500 });
    });
  });

  describe("sem o span da instrumentation-http", () => {
    const serverSpans = () => terminados.filter((span) => span.kind === SpanKind.SERVER);

    test("abre um span SERVER só: nome com a rota e os atributos da requisição", async () => {
      await startApp(undefined, undefined, { instrumentado: false });
      const resposta = await fetch(`${base}/api/imoveis/7?x=1`, {
        headers: { authorization: "Bearer segredo" },
      });
      await settle();

      expect(serverSpans()).toHaveLength(1);
      const span = findServerSpan();
      expect(span.name).toBe("GET /api/imoveis/:id");
      expect(span.instrumentationScope.name).toBe("@mateusseiboth/ts-decorators");
      expect(span.attributes).toMatchObject({
        "http.route": "/api/imoveis/:id",
        "http.request.method": "GET",
        "http.response.status_code": 200,
        "url.path": "/api/imoveis/7",
        "url.scheme": "http",
        "server.port": Number(new URL(base).port),
        "app.request_id": resposta.headers.get("x-request-id"),
        "http.request.header.authorization": "[redacted]",
      });
      expect(span.ended).toBe(true);
      expect(resposta.headers.get("x-trace-id")).toBe(span.spanContext().traceId);
    });

    test("traceparent vira o pai do span", async () => {
      await startApp(undefined, undefined, { instrumentado: false });
      await fetch(`${base}/api/imoveis/7`, {
        headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
      });
      await settle();
      const span = findServerSpan();
      expect(span.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
      expect(span.parentSpanContext?.spanId).toBe("b7ad6b7169203331");
    });

    test("X-Trace-Id do gateway, sem traceparent, vira o trace id", async () => {
      await startApp(undefined, undefined, { instrumentado: false });
      const resposta = await fetch(`${base}/api/imoveis/7`, {
        headers: { "x-trace-id": "4bf92f3577b34da6a3ce929d0e0e4736" },
      });
      await settle();
      expect(findServerSpan().spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(resposta.headers.get("x-trace-id")).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    });

    test("é o span ativo da requisição: o do handler nasce filho, e o log leva o trace dele", async () => {
      await startApp(undefined, undefined, { instrumentado: false });
      await fetch(`${base}/filho`);
      await settle();
      const servidor = findServerSpan();
      const filho = terminados.find((span) => span.name === "consulta")!;
      expect(filho.parentSpanContext?.spanId).toBe(servidor.spanContext().spanId);
      expect(linhas.find((l) => l.msg === "no filho")!.trace_id).toBe(
        servidor.spanContext().traceId,
      );
      expect(linhas.find((l) => l.msg === "http")!.trace_id).toBe(servidor.spanContext().traceId);
    });

    test("5xx marca o span com erro", async () => {
      await startApp(undefined, undefined, { instrumentado: false });
      await fetch(`${base}/quebra`);
      await settle();
      expect(findServerSpan().status.code).toBe(SpanStatusCode.ERROR);
    });

    test("/health e os ignorePaths não ganham span", async () => {
      await startApp({ ignorePaths: [/^\/contexto/] }, undefined, { instrumentado: false });
      await fetch(`${base}/contexto`);
      await stopApp();
      await startApp(undefined, undefined, { instrumentado: false });
      await fetch(`${base}/health`);
      await settle();
      expect(terminados).toEqual([]);
    });

    test("os ignorePaths valem também para a instrumentation-http", async () => {
      await startApp({ ignorePaths: [/^\/contexto/] }, undefined, { instrumentado: false });
      expect(isIgnoredRequest({ url: "/contexto?x=1" })).toBe(true);
      expect(isIgnoredRequest({ url: "/health" })).toBe(false);
      setIgnoredPaths();
    });

    test("outro span já ativo na requisição: não abre um segundo SERVER", async () => {
      const openInterno: express.RequestHandler = (_req, res, next) => {
        const span = tracer().startSpan("de fora");
        res.once("close", () => setImmediate(() => span.end()));
        context.with(trace.setSpan(context.active(), span), next);
      };
      await startApp(undefined, openInterno, { instrumentado: false });
      await fetch(`${base}/api/imoveis/7`);
      await settle();
      expect(serverSpans()).toHaveLength(0);
      expect(terminados.map((span) => span.name)).toEqual(["de fora"]);
    });
  });
});

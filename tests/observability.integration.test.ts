/**
 * Integração de ponta a ponta, num processo próprio: `bun --preload <preload> app.ts`, com o
 * Express importado por `import` (ESM) e os exportadores `console` (uma linha JSON por span e por
 * métrica no stdout). É a prova de que o preload corrige o SDK subindo depois do Express.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

const RAIZ = path.join(import.meta.dir, "..");
const PRELOAD = path.join(RAIZ, "src/observability/preload.ts");
const APP = path.join(import.meta.dir, "fixtures/observability/app.ts");

const TRACE_ID_DO_GATEWAY = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT_ID = "0af7651916cd43dd8448eb211c80319c";
const TRACEPARENT_PAI = "b7ad6b7169203331";
const TRACE_ID_DO_HEALTH = "11111111111111111111111111111111";
const ERRO = 2;

type Linha = Record<string, any>;

interface Processo {
  linhas: Linha[];
  portas: { a: number; b: number };
  codigo: Promise<number>;
  stop: () => Promise<number>;
}

/** Lê o stdout linha a linha; resolve quando o app imprime as portas. */
async function startApp(env: Record<string, string>): Promise<Processo> {
  const filho = Bun.spawn([process.execPath, "--preload", PRELOAD, APP], {
    cwd: RAIZ,
    env: {
      ...process.env,
      OTEL_SERVICE_NAME: "teste-obs",
      OTEL_SERVICE_VERSION: "9.9.9",
      DEPLOY_ENV: "teste",
      OTEL_TRACES_EXPORTER: "console",
      OTEL_METRICS_EXPORTER: "console",
      OTEL_METRIC_EXPORT_INTERVAL: "600000",
      LOG_FORMAT: "json",
      LOG_LEVEL: "info",
      ...env,
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const linhas: Linha[] = [];
  let resolvePortas: (portas: Processo["portas"]) => void = () => {};
  const portas = new Promise<Processo["portas"]>((resolve) => (resolvePortas = resolve));

  void (async () => {
    let resto = "";
    for await (const pedaco of filho.stdout) {
      resto += new TextDecoder().decode(pedaco);
      const partes = resto.split("\n");
      resto = partes.pop() ?? "";
      for (const texto of partes.filter(Boolean)) {
        const linha = JSON.parse(texto) as Linha;
        linhas.push(linha);
        if (linha.pronto) resolvePortas(linha.pronto);
      }
    }
  })();

  return {
    linhas,
    portas: await portas,
    codigo: filho.exited,
    stop: async () => {
      filho.kill("SIGTERM");
      return filho.exited;
    },
  };
}

const spans = (linhas: Linha[]) => linhas.filter((linha) => linha.otel === "span");
const SERVER = 1;

/** Qualquer span da requisição ao `/health`: o SERVER, o do middleware ou o de uma camada. */
const spansDoHealth = (linhas: Linha[]) =>
  spans(linhas).filter(
    (s) =>
      s.traceId === TRACE_ID_DO_HEALTH ||
      s.name.includes("/health") ||
      Object.values(s.attributes).some((valor) => String(valor).startsWith("/health")),
  );
const CLIENT = 2;

const findServerSpan = (linhas: Linha[], rota: string, porta: number) =>
  spans(linhas).find(
    (span) =>
      span.kind === SERVER &&
      span.attributes["http.route"] === rota &&
      span.attributes["server.port"] === porta,
  );

describe("observabilidade com o preload, de ponta a ponta", () => {
  let app: Processo;
  const respostas: Record<string, Response> = {};
  let corpoEncadeado: { recebido: Record<string, string> };
  let codigoDeSaida = -1;

  beforeAll(async () => {
    app = await startApp({});
    const a = `http://127.0.0.1:${app.portas.a}`;
    respostas.item = await fetch(`${a}/api/itens/7?pagina=1`, {
      headers: { authorization: "Bearer segredo" },
    });
    respostas.encadeado = await fetch(`${a}/encadeado`);
    corpoEncadeado = (await respostas.encadeado.json()) as typeof corpoEncadeado;
    respostas.gateway = await fetch(`${a}/api/itens/1`, {
      headers: { "x-trace-id": TRACE_ID_DO_GATEWAY },
    });
    respostas.invalido = await fetch(`${a}/api/itens/2`, {
      headers: { "x-trace-id": "nao-e-hex" },
    });
    respostas.traceparent = await fetch(`${a}/api/itens/3`, {
      headers: {
        traceparent: `00-${TRACEPARENT_ID}-${TRACEPARENT_PAI}-01`,
        "x-trace-id": TRACE_ID_DO_GATEWAY,
      },
    });
    respostas.health = await fetch(`${a}/health`, {
      headers: { traceparent: `00-${TRACE_ID_DO_HEALTH}-${TRACEPARENT_PAI}-01` },
    });
    respostas.falha = await fetch(`${a}/api/falha`);
    for (const resposta of Object.values(respostas)) if (!resposta.bodyUsed) await resposta.text();
    codigoDeSaida = await app.stop();
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
  });

  test("o desligamento descarrega tudo e sai com 0", () => {
    expect(codigoDeSaida).toBe(0);
  });

  test("o Express importado por ESM ganha o span SERVER com http.route e os spans do Express", () => {
    const span = findServerSpan(app.linhas, "/api/itens/:id", app.portas.a)!;
    expect(span).toBeDefined();
    expect(span.name).toBe("GET /api/itens/:id");
    // Os spans de camada (router, request handler) só existem se a instrumentation-express
    // enganchou o módulo: é o que falhava com o SDK subindo depois do import.
    expect(
      spans(app.linhas).some(
        (s) => s.traceId === span.traceId && s.attributes["express.type"] === "request_handler",
      ),
    ).toBe(true);
  });

  test("um span SERVER só por requisição, com os atributos do observeHttp", () => {
    const daRequisicao = spans(app.linhas).filter(
      (s) => s.kind === SERVER && s.attributes["url.path"] === "/api/itens/7",
    );
    expect(daRequisicao).toHaveLength(1);
    expect(daRequisicao[0]!.attributes).toMatchObject({
      "app.request_id": respostas.item!.headers.get("x-request-id"),
      "http.request.header.authorization": "[redacted]",
      "http.response.status_code": 200,
    });
    expect(respostas.item!.headers.get("x-trace-id")).toBe(daRequisicao[0]!.traceId);
  });

  test("/health não gera span nenhum", () => {
    expect(respostas.health.status).toBe(200);
    expect(spansDoHealth(app.linhas)).toEqual([]);
  });

  test("5xx: o span SERVER sai com status de erro", () => {
    const span = findServerSpan(app.linhas, "/api/falha", app.portas.a)!;
    expect(span.status).toBe(ERRO);
  });

  test("o Resource leva serviço, versão, ambiente, host e instância", () => {
    expect(spans(app.linhas)[0]!.resource).toMatchObject({
      "service.name": "teste-obs",
      "service.version": "9.9.9",
      "deployment.environment.name": "teste",
    });
    expect(spans(app.linhas)[0]!.resource["host.name"]).toBeString();
    expect(spans(app.linhas)[0]!.resource["service.instance.id"]).toBeString();
  });

  test("A chama B pelo fetch: o mesmo trace nos dois servidores, B filho do span CLIENT", () => {
    const servidorA = findServerSpan(app.linhas, "/encadeado", app.portas.a)!;
    const servidorB = findServerSpan(app.linhas, "/api/destino", app.portas.b)!;
    // O pai do CLIENT é o span ativo no handler (o `request handler` do Express), dentro de A.
    const cliente = spans(app.linhas).find(
      (s) => s.kind === CLIENT && s.traceId === servidorA.traceId,
    )!;

    expect(servidorB.traceId).toBe(servidorA.traceId);
    expect(cliente.scope).toBe("@mateusseiboth/ts-decorators");
    expect(servidorB.parentSpanId).toBe(cliente.spanId);
    expect(corpoEncadeado.recebido["x-request-id"]).toBe(
      respostas.encadeado!.headers.get("x-request-id")!,
    );
  });

  test("X-Trace-Id do gateway, sem traceparent, vira o trace id do servidor", () => {
    expect(respostas.gateway!.headers.get("x-trace-id")).toBe(TRACE_ID_DO_GATEWAY);
    const span = spans(app.linhas).find(
      (s) => s.kind === SERVER && s.attributes["url.path"] === "/api/itens/1",
    )!;
    expect(span.traceId).toBe(TRACE_ID_DO_GATEWAY);
  });

  test("X-Trace-Id inválido é ignorado", () => {
    expect(respostas.invalido!.headers.get("x-trace-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(respostas.invalido!.headers.get("x-trace-id")).not.toBe("nao-e-hex");
  });

  test("traceparent vence o X-Trace-Id", () => {
    expect(respostas.traceparent!.headers.get("x-trace-id")).toBe(TRACEPARENT_ID);
  });

  test("console.log do handler e o log de acesso saem em JSON, correlacionados", () => {
    const traceId = respostas.item!.headers.get("x-trace-id");
    const requestId = respostas.item!.headers.get("x-request-id");
    const doHandler = app.linhas.find((l) => l.msg === "lendo item" && l.id === "7")!;
    expect(doHandler).toMatchObject({
      level: "info",
      service: "teste-obs",
      env: "teste",
      trace_id: traceId,
      request_id: requestId,
    });
    const acesso = app.linhas.find((l) => l.msg === "http" && l.request_id === requestId)!;
    expect(acesso).toMatchObject({
      method: "GET",
      route: "/api/itens/:id",
      status: 200,
      trace_id: traceId,
    });
  });

  test("métricas: a duração HTTP sai só do observeHttp, com os buckets da especificação", () => {
    const duracoes = app.linhas.filter(
      (l) => l.otel === "metric" && l.name === "http.server.request.duration",
    );
    expect(duracoes.map((m) => m.scope)).toEqual(["@mateusseiboth/ts-decorators"]);
    expect(duracoes[0]!.unit).toBe("s");
    expect(duracoes[0]!.points[0].boundaries).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.35, 0.5, 0.75, 1, 1.5, 2.5, 5, 7.5, 10,
      20, 30, 60,
    ]);
    const rotas = duracoes[0]!.points.map((p: Linha) => p.attributes["http.route"]);
    expect(rotas).toContain("/api/itens/:id");
    expect(app.linhas.some((l) => l.otel === "metric" && l.name === "http.server.duration")).toBe(
      false,
    );
  });

  test("métricas: o startObservability liga as métricas padrão (runtime, drain)", () => {
    const nomes = new Set(app.linhas.filter((l) => l.otel === "metric").map((l) => l.name));
    expect(nomes).toContain("process.uptime");
    expect(nomes).toContain("process.memory.usage");
    expect(nomes).toContain("app.drain.active");
  });

  test("métricas: o fetch registra http.client.request.duration", () => {
    const cliente = app.linhas.find(
      (l) =>
        l.otel === "metric" &&
        l.name === "http.client.request.duration" &&
        l.scope === "@mateusseiboth/ts-decorators",
    )!;
    expect(cliente.points[0].attributes).toEqual({
      "http.request.method": "GET",
      "server.address": "127.0.0.1",
      "http.response.status_code": 200,
    });
  });
});

const INSTRUMENTATION_HTTP = "@opentelemetry/instrumentation-http";
const TS_DECORATORS = "@mateusseiboth/ts-decorators";

/**
 * O bug: no Bun, o `https` carregado pelo `require` depois do `http` desfazia o gancho do servidor
 * HTTP, e a requisição ficava sem span SERVER. Com o `https` carregado antes, a instrumentação
 * segue abrindo o span; sem gancho nenhum (`unhooked`), o `observeHttp` abre o dele. Em todos os
 * modos sai exatamente um, completo.
 */
describe.each([
  ["https", INSTRUMENTATION_HTTP],
  ["cjs-https", INSTRUMENTATION_HTTP],
  ["unhooked", TS_DECORATORS],
])("FIXTURE_MODO=%s: um span SERVER por requisição", (modo, escopo) => {
  let app: Processo;
  const respostas: Record<string, Response> = {};

  beforeAll(async () => {
    app = await startApp({ FIXTURE_MODO: modo });
    const a = `http://127.0.0.1:${app.portas.a}`;
    respostas.item = await fetch(`${a}/api/itens/7?pagina=1`, {
      headers: { authorization: "Bearer segredo" },
    });
    respostas.encadeado = await fetch(`${a}/encadeado`);
    respostas.gateway = await fetch(`${a}/api/itens/1`, {
      headers: { "x-trace-id": TRACE_ID_DO_GATEWAY },
    });
    respostas.traceparent = await fetch(`${a}/api/itens/3`, {
      headers: { traceparent: `00-${TRACEPARENT_ID}-${TRACEPARENT_PAI}-01` },
    });
    respostas.health = await fetch(`${a}/health`, {
      headers: { traceparent: `00-${TRACE_ID_DO_HEALTH}-${TRACEPARENT_PAI}-01` },
    });
    respostas.falha = await fetch(`${a}/api/falha`);
    for (const resposta of Object.values(respostas)) await resposta.text();
    await app.stop();
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
  });

  const findDoCaminho = (caminho: string) =>
    spans(app.linhas).filter((s) => s.kind === SERVER && s.attributes["url.path"] === caminho);

  test("exatamente um span SERVER, com nome, rota e os atributos do observeHttp", () => {
    const daRequisicao = findDoCaminho("/api/itens/7");
    expect(daRequisicao).toHaveLength(1);
    expect(daRequisicao[0].name).toBe("GET /api/itens/:id");
    expect(daRequisicao[0].attributes).toMatchObject({
      "http.route": "/api/itens/:id",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "server.port": app.portas.a,
      "app.request_id": respostas.item.headers.get("x-request-id"),
      "http.request.header.authorization": "[redacted]",
    });
  });

  test(`o span SERVER vem de ${escopo}, e as camadas do Express são filhas dele`, () => {
    const span = findDoCaminho("/api/itens/7")[0];
    expect(span.scope).toBe(escopo);
    const camada = spans(app.linhas).find(
      (s) => s.traceId === span.traceId && s.attributes["express.type"] === "request_handler",
    );
    expect(camada).toBeDefined();
  });

  test("x-trace-id da resposta, log do handler e log de acesso falam do mesmo span", () => {
    const span = findDoCaminho("/api/itens/7")[0];
    const requestId = respostas.item.headers.get("x-request-id");
    expect(respostas.item.headers.get("x-trace-id")).toBe(span.traceId);
    const doHandler = app.linhas.find((l) => l.msg === "lendo item" && l.id === "7")!;
    expect(doHandler.trace_id).toBe(span.traceId);
    const acesso = app.linhas.find((l) => l.msg === "http" && l.request_id === requestId)!;
    expect(acesso.trace_id).toBe(span.traceId);
  });

  test("X-Trace-Id do gateway e traceparent continuam o trace", () => {
    expect(findDoCaminho("/api/itens/1")[0].traceId).toBe(TRACE_ID_DO_GATEWAY);
    const filho = findDoCaminho("/api/itens/3")[0];
    expect(filho.traceId).toBe(TRACEPARENT_ID);
    expect(filho.parentSpanId).toBe(TRACEPARENT_PAI);
  });

  test("o fetch do handler nasce dentro do trace do servidor, e B é filho dele", () => {
    const servidorA = findDoCaminho("/encadeado")[0];
    const servidorB = findDoCaminho("/api/destino")[0];
    const cliente = spans(app.linhas).find(
      (s) => s.kind === CLIENT && s.traceId === servidorA.traceId,
    )!;
    expect(cliente).toBeDefined();
    expect(servidorB.traceId).toBe(servidorA.traceId);
    expect(servidorB.parentSpanId).toBe(cliente.spanId);
  });

  test("5xx sai com status de erro", () => {
    expect(findDoCaminho("/api/falha")).toHaveLength(1);
    expect(findDoCaminho("/api/falha")[0].status).toBe(ERRO);
  });

  test("/health não gera span nenhum", () => {
    expect(respostas.health.status).toBe(200);
    expect(spansDoHealth(app.linhas)).toEqual([]);
  });
});

describe("observabilidade desligada", () => {
  test("OTEL_ENABLED=false: o app atende, sem span, e o log continua em JSON", async () => {
    const app = await startApp({ OTEL_ENABLED: "false" });
    const resposta = await fetch(`http://127.0.0.1:${app.portas.a}/api/itens/5`);
    await resposta.text();
    await app.stop();

    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("x-request-id")).toBeString();
    expect(spans(app.linhas)).toHaveLength(0);
    expect(app.linhas.some((l) => l.msg === "lendo item")).toBe(true);
  }, 60_000);
});

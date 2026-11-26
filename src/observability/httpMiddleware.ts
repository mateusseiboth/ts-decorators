/**
 * `observeHttp`: o middleware do Express que completa a observação de cada requisição.
 *
 * Garante UM span SERVER por requisição: enriquece o que a instrumentation-http abriu (rota,
 * tenant, usuário, request id, headers mascarados, corpo quando pedido) e, quando ela não abriu
 * nenhum, abre o dele com os mesmos atributos. Registra as métricas HTTP, devolve `x-request-id` e
 * `x-trace-id` e escreve UMA linha de acesso no log.
 *
 * Custo por requisição sem corpo marcado: guardar referências e montar os atributos no fim. O
 * corpo só é serializado quando a requisição foi marcada (`@Auditable`, `markBodyCapture`).
 */
import {
  SpanStatusCode,
  context,
  metrics,
  trace,
  type Attributes,
  type Context,
  type Histogram,
  type Span,
  type UpDownCounter,
} from "@opentelemetry/api";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { logger } from "../functions/logger";
import { getHandlerContext, hasTenant, type HandlerContext } from "../handlers/context";
import { isBodyCaptureMarked } from "./bodyCapture";
import { BUCKETS_PADRAO } from "./buckets";
import {
  CAMINHOS_IGNORADOS,
  SEM_ROTA,
  buildHeaderAttributes,
  isIgnoredPath,
  readPath,
  readRequestId,
  readRoute,
  serializeBody,
  setIgnoredPaths,
} from "./httpAttributes";
import { runInRequestScope, type RequestScope } from "./requestScope";
import { findServerSpan, startServerSpan } from "./serverSpan";

export interface ObserveHttpOptions {
  /** Uma linha de log por requisição (`msg: "http"`). Default: `true`. */
  accessLog?: boolean;
  /**
   * Caminhos fora das métricas, do log de acesso e do trace (nem o span da instrumentation-http
   * sai). Substitui a lista padrão: `/health*`, `/internal/drain*` e `/metrics`.
   */
  ignorePaths?: readonly RegExp[];
  /** Headers da requisição e da resposta no span, mascarados. Default: `true`. */
  captureHeaders?: boolean;
  /**
   * Teto, em bytes, de cada corpo gravado no span de uma requisição marcada. Default: 1 MB. O
   * corpo acima do teto é cortado e diz o tamanho original.
   */
  maxBodyBytes?: number;
}

export const METER_NAME = "@mateusseiboth/ts-decorators";
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const REQUEST_ID_HEADER = "x-request-id";
const TRACE_ID_HEADER = "x-trace-id";
const INVALID_TRACE_ID = "0".repeat(32);

interface Instrumentos {
  duracao: Histogram;
  ativas: UpDownCounter;
  corpoEntrada: Histogram;
  corpoSaida: Histogram;
}

let _instrumentos: Instrumentos | undefined;

/** Criados na primeira requisição: antes do SDK registrado, o meter global é o vazio. */
const getInstrumentos = (): Instrumentos => {
  _instrumentos ??= buildInstrumentos();
  return _instrumentos;
};

const buildInstrumentos = (): Instrumentos => {
  const meter = metrics.getMeter(METER_NAME);
  return {
    duracao: meter.createHistogram("http.server.request.duration", {
      description: "Duration of HTTP server requests.",
      unit: "s",
      advice: { explicitBucketBoundaries: BUCKETS_PADRAO["http.server.request.duration"] },
    }),
    ativas: meter.createUpDownCounter("http.server.active_requests", {
      description: "Number of active HTTP server requests.",
      unit: "{request}",
    }),
    corpoEntrada: meter.createHistogram("http.server.request.body.size", {
      description: "Size of HTTP server request bodies.",
      unit: "By",
    }),
    corpoSaida: meter.createHistogram("http.server.response.body.size", {
      description: "Size of HTTP server response bodies.",
      unit: "By",
    }),
  };
};

/** Esquece os instrumentos criados (testes que trocam o meter global). */
export function resetHttpInstruments(): void {
  _instrumentos = undefined;
}

// ── Estado de uma requisição ──────────────────────────────────────────────────────────────────

interface Observacao {
  req: Request;
  res: Response;
  inicio: number;
  method: string;
  requestId: string;
  span?: Span;
  /** O span foi aberto aqui: o `observeHttp` grava o status e o encerra. */
  proprio: boolean;
  /** O contexto em que o resto da requisição roda (o do span aberto aqui). */
  contextoDoSpan?: Context;
  /** O contexto do handler visto quando a resposta começou a sair (dentro do handler). */
  contexto?: HandlerContext;
  rota?: string;
  /** A rota completa lida quando casou, com o prefixo do router aninhado. Vale a última. */
  rotaCasada?: string;
  bytesSaida: number;
  /** O primeiro corpo passado ao `res.json`/`res.send`, guardado por referência. */
  corpo?: { valor: unknown };
}

type Config = Required<ObserveHttpOptions>;

const readTraceId = (span: Span | undefined): string | undefined => {
  const traceId = span?.spanContext().traceId;
  return traceId && traceId !== INVALID_TRACE_ID ? traceId : undefined;
};

const readUserId = (ctx: HandlerContext | undefined): string | undefined => {
  const id = ctx?.user?.id ?? ctx?.user?.userId;
  return id === undefined || id === null ? undefined : String(id);
};

const readTenant = (ctx: HandlerContext | undefined) =>
  hasTenant(ctx?.entity) ? ctx.entity : undefined;

const readContentLength = (valor: unknown): number | undefined => {
  const numero = Number(valor);
  return valor !== undefined && valor !== "" && Number.isFinite(numero) ? numero : undefined;
};

const readChunkBytes = (chunk: unknown): number => {
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  return (chunk as Uint8Array | undefined)?.byteLength ?? 0;
};

/** Contexto, rota e headers no momento em que a resposta começa a sair, ainda no handler. */
const snapshot = (observacao: Observacao): void => {
  observacao.contexto ??= getHandlerContext();
  observacao.rota ??= readRoute(observacao.req);
};

/** Guarda a rota casada só quando ela tem caminho: `(sem rota)` fica para o fim, como fallback. */
const captureRoute = (observacao: Observacao, route: Request["route"]): void => {
  const rota = readRoute({ baseUrl: observacao.req.baseUrl, route });
  if (rota !== SEM_ROTA) observacao.rotaCasada = rota;
};

/**
 * O router do Express grava `req.route` quando a rota casa (`router/index.js`, no `next`, e
 * `router/lib/route.js`, no `dispatch`), com o `req.baseUrl` ainda no prefixo do router aninhado.
 * Quando o erro sobe até o handler global, o router já devolveu o `baseUrl` do pai, mas não o
 * `req.route`: lida no fim, a rota perderia o prefixo do módulo e rotas de módulos diferentes
 * cairiam no mesmo `http.route`. Por isso a rota é lida no momento em que casa. O `req.route`
 * continua devolvendo o mesmo objeto para o Express e para o app.
 */
const watchRoute = (observacao: Observacao): void => {
  const { req } = observacao;
  if (Object.getOwnPropertyDescriptor(req, "route")?.configurable === false) return;
  let route: Request["route"] = req.route;
  captureRoute(observacao, route);
  Object.defineProperty(req, "route", {
    configurable: true,
    enumerable: true,
    get: () => route,
    set: (valor: Request["route"]) => {
      route = valor;
      captureRoute(observacao, valor);
    },
  });
};

/**
 * Intercepta o mínimo da resposta: o `writeHead` (o Bun e o Node chamam no primeiro `write`/`end`)
 * para ler o contexto, o `write`/`end` para contar bytes, e o `json`/`send` para guardar o corpo.
 */
const interceptResponse = (observacao: Observacao): void => {
  const { res } = observacao;
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
  res.writeHead = ((...args: unknown[]) => {
    snapshot(observacao);
    return writeHead(...args);
  }) as Response["writeHead"];

  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  res.write = ((chunk: unknown, ...args: unknown[]) => {
    observacao.bytesSaida += readChunkBytes(chunk);
    return write(chunk, ...args);
  }) as Response["write"];

  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  res.end = ((chunk?: unknown, ...args: unknown[]) => {
    snapshot(observacao);
    if (typeof chunk !== "function") observacao.bytesSaida += readChunkBytes(chunk);
    return end(chunk, ...args);
  }) as Response["end"];

  const keepBody = (valor: unknown) => {
    observacao.corpo ??= { valor };
  };
  const json = res.json.bind(res);
  res.json = (body?: unknown) => {
    keepBody(body);
    return json(body);
  };
  const send = res.send.bind(res);
  res.send = (body?: unknown) => {
    keepBody(body);
    return send(body);
  };
};

// ── Fim da requisição ─────────────────────────────────────────────────────────────────────────

const readBytesSaida = (observacao: Observacao): number =>
  readContentLength(observacao.res.getHeader("content-length")) ?? observacao.bytesSaida;

const buildBodyAttributes = (observacao: Observacao, config: Config): Attributes => {
  if (!isBodyCaptureMarked(observacao.req)) return {};
  const { req, res, corpo } = observacao;
  return {
    "http.request.body": serializeBody(req.body, req.headers["content-type"], config.maxBodyBytes),
    "http.response.body": serializeBody(
      corpo?.valor,
      res.getHeader("content-type")?.toString(),
      config.maxBodyBytes,
    ),
  };
};

const buildHeaderAttributesOf = (observacao: Observacao, config: Config): Attributes => {
  if (!config.captureHeaders) return {};
  return {
    ...buildHeaderAttributes("http.request.header", observacao.req.headers),
    ...buildHeaderAttributes("http.response.header", observacao.res.getHeaders()),
  };
};

const enrichSpan = (observacao: Observacao, rota: string, config: Config): void => {
  const { span, res, contexto } = observacao;
  if (!span) return;
  const tenant = readTenant(contexto);
  const userId = readUserId(contexto);
  span.setAttributes({
    "http.route": rota,
    "app.request_id": observacao.requestId,
    ...(tenant === undefined ? {} : { tenant }),
    ...(userId === undefined ? {} : { "enduser.id": userId }),
    ...buildHeaderAttributesOf(observacao, config),
    ...buildBodyAttributes(observacao, config),
  });
  if (rota !== SEM_ROTA) span.updateName(`${observacao.method} ${rota}`);
  if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
};

const recordMetrics = (observacao: Observacao, rota: string, duracaoS: number): void => {
  const { method, req, res } = observacao;
  const instrumentos = getInstrumentos();
  const tenant = readTenant(observacao.contexto);
  const porRota = { "http.request.method": method, "http.route": rota };
  instrumentos.duracao.record(duracaoS, {
    ...porRota,
    "http.response.status_code": res.statusCode,
    ...(tenant === undefined ? {} : { tenant }),
  });
  instrumentos.ativas.add(-1, { "http.request.method": method });
  const entrada = readContentLength(req.headers["content-length"]);
  if (entrada !== undefined) instrumentos.corpoEntrada.record(entrada, porRota);
  instrumentos.corpoSaida.record(readBytesSaida(observacao), porRota);
};

type NivelDoAcesso = "info" | "warn" | "error";

const readNivelDoAcesso = (status: number): NivelDoAcesso => {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
};

const buildScope = (observacao: Observacao): RequestScope => ({
  requestId: observacao.requestId,
  tenant: readTenant(observacao.contexto),
  userId: readUserId(observacao.contexto),
});

/** O `finish` sai fora do contexto do handler: o log roda dentro do span e do escopo dela. */
const writeAccessLog = (observacao: Observacao, rota: string, duracaoMs: number): void => {
  const { span, res, method } = observacao;
  const ctx = span ? trace.setSpan(context.active(), span) : context.active();
  context.with(ctx, () =>
    runInRequestScope(buildScope(observacao), () =>
      logger[readNivelDoAcesso(res.statusCode)]("http", {
        method,
        route: rota,
        status: res.statusCode,
        duration_ms: Math.round(duracaoMs * 100) / 100,
        bytes_out: readBytesSaida(observacao),
      }),
    ),
  );
};

/** O span aberto aqui leva o status da resposta e termina; o da instrumentação ela mesma fecha. */
const endOwnSpan = ({ span, proprio, res }: Observacao): void => {
  if (!proprio || !span) return;
  span.setAttribute("http.response.status_code", res.statusCode);
  span.end();
};

const finishObservacao = (observacao: Observacao, config: Config): void => {
  snapshot(observacao);
  const rota = observacao.rotaCasada ?? observacao.rota ?? SEM_ROTA;
  const duracaoMs = performance.now() - observacao.inicio;
  enrichSpan(observacao, rota, config);
  endOwnSpan(observacao);
  recordMetrics(observacao, rota, duracaoMs / 1000);
  if (config.accessLog) writeAccessLog(observacao, rota, duracaoMs);
};

// ── Middleware ────────────────────────────────────────────────────────────────────────────────

type SpanDaObservacao = Pick<Observacao, "span" | "proprio" | "contextoDoSpan">;

/**
 * O span SERVER em vigor: o da instrumentation-http, quando ela abriu. Sem ele e sem span ativo,
 * abre um aqui. Um span ativo sem o SERVER guardado é de quem já observa a requisição por fora:
 * abrir outro duplicaria o servidor no trace.
 */
const resolveServerSpan = (req: Request): SpanDaObservacao => {
  const capturado = findServerSpan(req);
  if (capturado) return { span: capturado, proprio: false };
  if (trace.getActiveSpan()) return { proprio: false };
  const { span, contexto } = startServerSpan(trace.getTracer(METER_NAME), req);
  return { span, proprio: true, contextoDoSpan: contexto };
};

/** O contexto aberto ANTES deste middleware decide o id; senão, o header que chegou ou um novo. */
const startObservacao = (req: Request, res: Response): Observacao => {
  const requestId = getHandlerContext()?.requestId ?? readRequestId(req.headers);
  const observacao: Observacao = {
    req,
    res,
    inicio: performance.now(),
    method: req.method,
    requestId,
    ...resolveServerSpan(req),
    bytesSaida: 0,
  };
  res.setHeader(REQUEST_ID_HEADER, requestId);
  const traceId = readTraceId(observacao.span);
  if (traceId) res.setHeader(TRACE_ID_HEADER, traceId);
  return observacao;
};

const resolveConfig = (options: ObserveHttpOptions = {}): Config => ({
  accessLog: options.accessLog ?? true,
  ignorePaths: options.ignorePaths ?? CAMINHOS_IGNORADOS,
  captureHeaders: options.captureHeaders ?? true,
  maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
});

/** Middleware de observação HTTP. Monte depois do `express.json()` e antes das rotas. */
export function observeHttp(options?: ObserveHttpOptions): RequestHandler {
  const config = resolveConfig(options);
  const isIgnored = (path: string) => isIgnoredPath(path, config.ignorePaths);
  setIgnoredPaths(config.ignorePaths);

  return function observeHttpMiddleware(req: Request, res: Response, next: NextFunction) {
    if (isIgnored(readPath(req.originalUrl ?? req.url))) return next();
    const observacao = startObservacao(req, res);
    getInstrumentos().ativas.add(1, { "http.request.method": observacao.method });
    interceptResponse(observacao);
    watchRoute(observacao);

    let terminou = false;
    const finish = () => {
      if (terminou) return;
      terminou = true;
      finishObservacao(observacao, config);
    };
    res.once("finish", finish);
    res.once("close", finish);
    context.with(observacao.contextoDoSpan ?? context.active(), () =>
      runInRequestScope({ requestId: observacao.requestId }, next),
    );
  };
}

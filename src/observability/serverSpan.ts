/**
 * O span SERVER de cada requisição.
 *
 * O normal é o da instrumentation-http, guardado no `requestHook` para o `observeHttp` achar: o
 * span ativo dentro de um middleware do Express é o do middleware (a instrumentation-express abre
 * um por camada), não o da requisição.
 *
 * Quando a instrumentação não abriu span nenhum, o `observeHttp` abre o dele (`startServerSpan`).
 * O caso conhecido, o `https` carregado depois do `http` no Bun, está explicado no `sdk.ts`; o
 * span daqui cobre esse e qualquer outro caminho em que o gancho do servidor se perca.
 */
import {
  SpanKind,
  context,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { Request } from "express";

import { readPath } from "./httpAttributes";

const _spans = new WeakMap<object, Span>();

export function saveServerSpan(req: object, span: Span): void {
  _spans.set(req, span);
}

export function findServerSpan(req: object): Span | undefined {
  return _spans.get(req);
}

export interface ServerSpanProprio {
  span: Span;
  /** O contexto em que o resto da requisição roda: o span é o ativo, filho do que chegou. */
  contexto: Context;
}

type RequisicaoDoSpan = Pick<
  Request,
  "method" | "originalUrl" | "url" | "headers" | "protocol" | "hostname" | "socket" | "httpVersion"
>;

const buildStartAttributes = (req: RequisicaoDoSpan): Attributes => {
  const atributos: Attributes = {
    "http.request.method": req.method,
    "url.path": readPath(req.originalUrl ?? req.url),
    "url.scheme": req.protocol,
    "server.address": req.hostname,
    "server.port": req.socket.localPort,
    "network.protocol.version": req.httpVersion,
    "user_agent.original": req.headers["user-agent"],
  };
  return Object.fromEntries(Object.entries(atributos).filter(([, valor]) => valor !== undefined));
};

/**
 * Abre o span SERVER da requisição: o pai vem dos headers que chegaram (`traceparent` ou o
 * `X-Trace-Id` do gateway, pelo propagador registrado no SDK).
 */
export function startServerSpan(tracer: Tracer, req: RequisicaoDoSpan): ServerSpanProprio {
  const pai = propagation.extract(context.active(), req.headers);
  const span = tracer.startSpan(
    req.method,
    { kind: SpanKind.SERVER, attributes: buildStartAttributes(req) },
    pai,
  );
  return { span, contexto: trace.setSpan(pai, span) };
}

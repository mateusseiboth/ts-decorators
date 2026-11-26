/**
 * Instrumentação do `fetch` global. O `fetch` do Bun não passa pela instrumentation-undici:
 * sem isto, a chamada a outro serviço não aparece no trace e não leva o contexto adiante.
 *
 * Cada chamada vira um span CLIENT (`GET`, `POST`...), recebe `traceparent`, `X-Trace-Id` e o
 * `x-request-id` da requisição em andamento, e registra `http.client.request.duration`.
 */
import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  type Meter,
  type Span,
  type TextMapSetter,
  type Tracer,
} from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";

import { getHandlerContext } from "../handlers/context";
import { BUCKETS_PADRAO } from "./buckets";
import { REDACTED, isSensitiveKey } from "./redact";
import { getRequestScope } from "./requestScope";

export interface FetchInstrumentationOptions {
  tracer: Tracer;
  meter: Meter;
  /** URL que passa direto, sem span e sem header (o endpoint OTLP). */
  ignoreUrl?: (url: URL) => boolean;
}

const METRICA = "http.client.request.duration";
const MARCA = Symbol.for("ts-decorators:fetch-instrumentado");
const REQUEST_ID = "x-request-id";

type FetchFn = typeof fetch;
type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

interface Chamada {
  url: URL;
  method: string;
  rotulos: Record<string, string | number>;
}

const headersSetter: TextMapSetter<Headers> = {
  set: (carrier, chave, valor) => carrier.set(chave, valor),
};

const readUrl = (input: FetchInput): URL | undefined => {
  const texto = input instanceof Request ? input.url : String(input);
  try {
    return new URL(texto);
  } catch {
    return undefined;
  }
};

const readMethod = (input: FetchInput, init: FetchInit): string =>
  (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

/** Sem usuário e senha, e com o valor das chaves sensíveis da query mascarado. */
const sanitizeUrl = (url: URL): string => {
  const limpa = new URL(url);
  limpa.username = "";
  limpa.password = "";
  for (const chave of [...limpa.searchParams.keys()]) {
    if (isSensitiveKey(chave)) limpa.searchParams.set(chave, REDACTED);
  }
  return limpa.toString();
};

const readPort = (url: URL): number => Number(url.port || (url.protocol === "https:" ? 443 : 80));

const readRequestId = (): string | undefined =>
  getHandlerContext()?.requestId ?? getRequestScope()?.requestId;

/** Os headers da chamada mais o contexto do trace e o id da requisição em andamento. */
const buildHeaders = (input: FetchInput, init: FetchInit): Headers => {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  propagation.inject(context.active(), headers, headersSetter);
  const requestId = readRequestId();
  if (requestId && !headers.has(REQUEST_ID)) headers.set(REQUEST_ID, requestId);
  return headers;
};

const buildChamada = (url: URL, method: string): Chamada => ({
  url,
  method,
  rotulos: { "http.request.method": method, "server.address": url.hostname },
});

const failSpan = (span: Span, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : message);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
};

const finishSpan = (span: Span, resposta: Response): void => {
  span.setAttribute("http.response.status_code", resposta.status);
  if (resposta.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
};

/** Liga a instrumentação. Devolve a função que devolve o `fetch` original. */
export function instrumentFetch(options: FetchInstrumentationOptions): () => void {
  const original = globalThis.fetch;
  if ((original as unknown as Record<symbol, unknown>)[MARCA]) return () => {};

  const { tracer, ignoreUrl = () => false } = options;
  const duracao = options.meter.createHistogram(METRICA, {
    description: "Duration of HTTP client requests.",
    unit: "s",
    advice: { explicitBucketBoundaries: BUCKETS_PADRAO[METRICA] },
  });

  const record = (chamada: Chamada, inicio: number, status?: number): void =>
    duracao.record((performance.now() - inicio) / 1000, {
      ...chamada.rotulos,
      ...(status === undefined ? {} : { "http.response.status_code": status }),
    });

  const runTraced = (chamada: Chamada, input: FetchInput, init: FetchInit) =>
    tracer.startActiveSpan(
      chamada.method,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          ...chamada.rotulos,
          "server.port": readPort(chamada.url),
          "url.full": sanitizeUrl(chamada.url),
        },
      },
      async (span) => {
        const inicio = performance.now();
        try {
          const resposta = await original(input, { ...init, headers: buildHeaders(input, init) });
          finishSpan(span, resposta);
          record(chamada, inicio, resposta.status);
          return resposta;
        } catch (error) {
          failSpan(span, error);
          record(chamada, inicio);
          throw error;
        } finally {
          span.end();
        }
      },
    );

  const instrumentado = ((input: FetchInput, init?: FetchInit) => {
    const url = readUrl(input);
    if (!url || ignoreUrl(url) || isTracingSuppressed(context.active())) {
      return original(input, init);
    }
    return runTraced(buildChamada(url, readMethod(input, init)), input, init);
  }) as FetchFn;

  // `fetch.preconnect` e afins do Bun continuam lá.
  Object.assign(instrumentado, original, { [MARCA]: true });
  globalThis.fetch = instrumentado;

  return () => {
    if (globalThis.fetch === instrumentado) globalThis.fetch = original;
  };
}

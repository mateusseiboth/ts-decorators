/**
 * Propagação do trace entre o gateway e os serviços.
 *
 * Entrada: o W3C (`traceparent`, `tracestate`, `baggage`) continua o trace. Sem `traceparent`, o
 * `X-Trace-Id` (32 hex) do gateway abre um contexto remoto com aquele trace id, e o span de
 * servidor nasce filho dele. Id inválido é ignorado.
 *
 * Saída: além do W3C, o `X-Trace-Id` com o trace id atual, para quem só entende esse header.
 */
import { randomBytes } from "node:crypto";

import {
  TraceFlags,
  isValidTraceId,
  trace,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

export const X_TRACE_ID = "x-trace-id";

const TRACE_ID_HEX = /^[0-9a-f]{32}$/;

const readHeader = (carrier: unknown, getter: TextMapGetter): string | undefined => {
  const valor = getter.get(carrier, X_TRACE_ID);
  const texto = Array.isArray(valor) ? valor[0] : valor;
  return texto?.trim().toLowerCase();
};

/** Só 32 hex, e não o id zerado. */
export const isTraceIdValido = (valor: string | undefined): valor is string =>
  valor !== undefined && TRACE_ID_HEX.test(valor) && isValidTraceId(valor);

const buildSpanIdAleatorio = (): string => randomBytes(8).toString("hex");

/** Lê e escreve o `X-Trace-Id`. Na leitura, só age quando o W3C não trouxe contexto. */
export class XTraceIdPropagator implements TextMapPropagator {
  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const spanContext = trace.getSpanContext(context);
    if (!spanContext || !isValidTraceId(spanContext.traceId)) return;
    setter.set(carrier, X_TRACE_ID, spanContext.traceId);
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    if (trace.getSpanContext(context)) return context;
    const traceId = readHeader(carrier, getter);
    if (!isTraceIdValido(traceId)) return context;
    return trace.setSpanContext(context, {
      traceId,
      spanId: buildSpanIdAleatorio(),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  }

  fields(): string[] {
    return [X_TRACE_ID];
  }
}

/** W3C trace context, baggage e, por último, o `X-Trace-Id`. */
export function buildTextMapPropagator(): TextMapPropagator {
  return new CompositePropagator({
    propagators: [
      new W3CTraceContextPropagator(),
      new W3CBaggagePropagator(),
      new XTraceIdPropagator(),
    ],
  });
}

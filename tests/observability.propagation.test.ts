import { describe, expect, test } from "bun:test";

import {
  ROOT_CONTEXT,
  TraceFlags,
  defaultTextMapGetter,
  defaultTextMapSetter,
  trace,
} from "@opentelemetry/api";

import { XTraceIdPropagator, buildTextMapPropagator } from "../src/observability/propagation";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const OUTRO_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const TRACEPARENT = `00-${OUTRO_TRACE_ID}-b7ad6b7169203331-01`;

const extract = (headers: Record<string, string>) =>
  trace.getSpanContext(
    buildTextMapPropagator().extract(ROOT_CONTEXT, headers, defaultTextMapGetter),
  );

describe("propagação de entrada", () => {
  test("traceparent W3C continua o trace", () => {
    expect(extract({ traceparent: TRACEPARENT })?.traceId).toBe(OUTRO_TRACE_ID);
  });

  test("traceparent vence o X-Trace-Id", () => {
    expect(extract({ traceparent: TRACEPARENT, "x-trace-id": TRACE_ID })?.traceId).toBe(
      OUTRO_TRACE_ID,
    );
  });

  test("sem traceparent, o X-Trace-Id vira contexto remoto amostrado", () => {
    const spanContext = extract({ "x-trace-id": TRACE_ID });
    expect(spanContext?.traceId).toBe(TRACE_ID);
    expect(spanContext?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spanContext?.isRemote).toBe(true);
    expect(spanContext?.traceFlags).toBe(TraceFlags.SAMPLED);
  });

  test("X-Trace-Id em maiúsculas também vale", () => {
    expect(extract({ "x-trace-id": TRACE_ID.toUpperCase() })?.traceId).toBe(TRACE_ID);
  });

  test.each([["curto"], ["0".repeat(32)], ["z".repeat(32)], [`${TRACE_ID}00`]])(
    "id inválido (%s) é ignorado",
    (invalido) => {
      expect(extract({ "x-trace-id": invalido })).toBeUndefined();
    },
  );
});

describe("propagação de saída", () => {
  test("injeta traceparent e X-Trace-Id do span atual", () => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE_ID,
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
    });
    const headers: Record<string, string> = {};
    buildTextMapPropagator().inject(ctx, headers, defaultTextMapSetter);

    expect(headers.traceparent).toBe(`00-${TRACE_ID}-b7ad6b7169203331-01`);
    expect(headers["x-trace-id"]).toBe(TRACE_ID);
  });

  test("sem span, não injeta nada", () => {
    const headers: Record<string, string> = {};
    new XTraceIdPropagator().inject(ROOT_CONTEXT, headers, defaultTextMapSetter);
    expect(headers).toEqual({});
  });

  test("declara os campos que usa", () => {
    expect(buildTextMapPropagator().fields()).toEqual(
      expect.arrayContaining(["traceparent", "tracestate", "baggage", "x-trace-id"]),
    );
  });
});

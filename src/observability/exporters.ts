/**
 * Exportadores: OTLP gRPC com gzip (o coletor), `console` (uma linha JSON por span e por métrica
 * no stdout, para depurar local e para os testes) e `none`.
 */
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import {
  DataPointType,
  type MetricData,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";

import type { ExporterKind } from "./options";

const SUCCESS: ExportResult = { code: ExportResultCode.SUCCESS };

const writeLine = (linha: object): void => {
  process.stdout.write(`${JSON.stringify(linha)}\n`);
};

const readDurationMs = (span: ReadableSpan): number =>
  span.duration[0] * 1000 + span.duration[1] / 1_000_000;

const buildSpanLine = (span: ReadableSpan) => ({
  otel: "span",
  name: span.name,
  kind: span.kind,
  traceId: span.spanContext().traceId,
  spanId: span.spanContext().spanId,
  parentSpanId: span.parentSpanContext?.spanId,
  status: span.status.code,
  scope: span.instrumentationScope.name,
  attributes: span.attributes,
  resource: span.resource.attributes,
  duration_ms: readDurationMs(span),
});

/** Uma linha JSON por span no stdout: `{"otel":"span", ...}`. */
export class JsonLineSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) writeLine(buildSpanLine(span));
    resultCallback(SUCCESS);
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

const buildPoint = (metrica: MetricData, ponto: MetricData["dataPoints"][number]) => {
  const valor = ponto.value as unknown;
  if (metrica.dataPointType !== DataPointType.HISTOGRAM)
    return { attributes: ponto.attributes, value: valor };
  const histograma = valor as { count: number; sum?: number; buckets: { boundaries: number[] } };
  return {
    attributes: ponto.attributes,
    value: { count: histograma.count, sum: histograma.sum },
    boundaries: histograma.buckets.boundaries,
  };
};

/** Uma linha JSON por métrica no stdout: `{"otel":"metric","scope","name","unit","points"}`. */
export class JsonLineMetricExporter implements PushMetricExporter {
  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    for (const escopo of metrics.scopeMetrics) {
      for (const metrica of escopo.metrics) {
        writeLine({
          otel: "metric",
          scope: escopo.scope.name,
          name: metrica.descriptor.name,
          unit: metrica.descriptor.unit,
          points: metrica.dataPoints.map((ponto) => buildPoint(metrica, ponto)),
        });
      }
    }
    resultCallback(SUCCESS);
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

const SPAN_EXPORTERS: Record<ExporterKind, (url: string) => SpanExporter | undefined> = {
  otlp: (url) => new OTLPTraceExporter({ url, compression: CompressionAlgorithm.GZIP }),
  console: () => new JsonLineSpanExporter(),
  none: () => undefined,
};

const METRIC_EXPORTERS: Record<ExporterKind, (url: string) => PushMetricExporter | undefined> = {
  otlp: (url) => new OTLPMetricExporter({ url, compression: CompressionAlgorithm.GZIP }),
  console: () => new JsonLineMetricExporter(),
  none: () => undefined,
};

const isKind = (valor: unknown): valor is ExporterKind => typeof valor === "string";

/** O exportador de spans pedido; `undefined` quando é `none`. */
export function buildSpanExporter(
  escolha: ExporterKind | SpanExporter,
  url: string,
): SpanExporter | undefined {
  return isKind(escolha) ? SPAN_EXPORTERS[escolha](url) : escolha;
}

/** O exportador de métricas pedido; `undefined` quando é `none`. */
export function buildMetricExporter(
  escolha: ExporterKind | PushMetricExporter,
  url: string,
): PushMetricExporter | undefined {
  return isKind(escolha) ? METRIC_EXPORTERS[escolha](url) : escolha;
}

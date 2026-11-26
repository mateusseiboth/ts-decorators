import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
/**
 * `startObservability`: sobe o SDK do OpenTelemetry (traces e métricas por OTLP gRPC), as
 * instrumentações, a propagação do gateway, o `fetch` instrumentado e o console no formato do
 * logger. Chame no preload (`bunfig.toml`), ANTES de qualquer `import` do Express.
 *
 * Por que o preload: no Bun, o `import` (ESM) de um pacote CommonJS não passa pelo `require` que
 * as instrumentações enganchar. Com o SDK de pé, o preload carrega `https`, `http` e `express`
 * pelo `require`: o `import` do projeto, depois, recebe a mesma cópia, já instrumentada.
 */
import { createRequire } from "node:module";
import { hostname } from "node:os";
import path from "node:path";

import { diag, DiagLogLevel, metrics, trace, type DiagLogger, type Span } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import {
  AggregationType,
  PeriodicExportingMetricReader,
  type IMetricReader,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import { onShutdown } from "../decorators/shutdown";
import { configureLogger, logger } from "../functions/logger";
import { BUCKETS_PADRAO } from "./buckets";
import { patchConsole } from "./console";
import { registerDefaultMetrics } from "./defaultMetrics";
import { buildMetricExporter, buildSpanExporter } from "./exporters";
import { instrumentFetch } from "./fetch";
import { isIgnoredRequest } from "./httpAttributes";
import { METER_NAME } from "./httpMiddleware";
import {
  resolveObservabilityOptions,
  type ObservabilityOptions,
  type ResolvedObservabilityOptions,
} from "./options";
import { buildTextMapPropagator } from "./propagation";
import { saveServerSpan } from "./serverSpan";

export interface ObservabilityHandle {
  /** `false` quando o SDK ficou desligado (`OTEL_ENABLED=false`): só o logger e o console valem. */
  readonly enabled: boolean;
  /** Manda agora os spans e as métricas pendentes. */
  forceFlush(): Promise<void>;
  /** Descarrega, encerra o SDK e devolve o `fetch` e o console originais. Idempotente. */
  shutdown(): Promise<void>;
}

const INSTRUMENTATION_HTTP_METER = "@opentelemetry/instrumentation-http";
const MAX_EXPORT_TIMEOUT_MS = 5_000;
const BSP_DELAY_MS = 5_000;

let _handle: ObservabilityHandle | undefined;

// ── Diagnóstico do próprio OpenTelemetry ──────────────────────────────────────────────────────

/** O Bun (JavaScriptCore) não tem `getHeapSpaceStatistics`: o aviso a cada coleta é só ruído. */
const isRuidoDoBun = (mensagem: string): boolean => mensagem.includes("getHeapSpaceStatistics");

const noop = () => {};

/** Erros do SDK saem pelo logger (JSON), sem o ruído do Bun. */
const quietDiagLogger: DiagLogger = {
  error: (mensagem, ...args) => {
    if (isRuidoDoBun(String(mensagem))) return;
    logger.error(`[otel] ${String(mensagem)}`, ...args);
  },
  warn: noop,
  info: noop,
  debug: noop,
  verbose: noop,
};

// ── Peças do SDK ──────────────────────────────────────────────────────────────────────────────

const buildResource = (config: ResolvedObservabilityOptions): Resource =>
  resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    "deployment.environment.name": config.environment,
    "host.name": hostname(),
    "service.instance.id": randomUUID(),
  });

/**
 * A `http.server.request.duration` da instrumentation-http sai: a do `observeHttp` tem a rota e a
 * tenant. A `http.server.duration` (ms) das versões antigas também. Os buckets valem só para o
 * meter do pacote: as instrumentações de terceiros ficam com os delas.
 */
const buildViews = (): ViewOptions[] => [
  { instrumentName: "http.server.duration", aggregation: { type: AggregationType.DROP } },
  {
    instrumentName: "http.server.request.duration",
    meterName: INSTRUMENTATION_HTTP_METER,
    aggregation: { type: AggregationType.DROP },
  },
  ...Object.entries(BUCKETS_PADRAO).map(([instrumentName, boundaries]): ViewOptions => ({
    instrumentName,
    meterName: METER_NAME,
    aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries } },
  })),
];

const buildSpanProcessors = (config: ResolvedObservabilityOptions): SpanProcessor[] => {
  const exporter = buildSpanExporter(config.traceExporter, config.tracesEndpoint);
  if (!exporter) return [];
  return [
    new BatchSpanProcessor({
      exporter,
      maxExportBatchSize: config.maxExportBatchSize,
      maxQueueSize: config.maxQueueSize,
      scheduledDelayMillis: BSP_DELAY_MS,
    }),
  ];
};

const buildMetricReaders = (config: ResolvedObservabilityOptions): IMetricReader[] => {
  const exporter = buildMetricExporter(config.metricExporter, config.metricsEndpoint);
  if (!exporter) return [];
  return [
    new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: config.metricExportIntervalMs,
      exportTimeoutMillis: Math.min(MAX_EXPORT_TIMEOUT_MS, config.metricExportIntervalMs),
    }),
  ];
};

/** O span SERVER fica guardado para o `observeHttp` achar (o ativo no middleware é o do Express). */
const saveIncomingSpan = (span: Span, request: unknown): void => {
  if (request instanceof IncomingMessage) saveServerSpan(request, span);
};

const buildInstrumentations = (config: ResolvedObservabilityOptions) => [
  getNodeAutoInstrumentations({
    "@opentelemetry/instrumentation-fs": { enabled: false },
    "@opentelemetry/instrumentation-runtime-node": { enabled: false },
    // As duas vêm configuradas logo abaixo: ligadas aqui também, cada requisição teria dois spans.
    "@opentelemetry/instrumentation-http": { enabled: false },
    "@opentelemetry/instrumentation-express": { enabled: false },
    // O Express 5 usa o pacote `router`: a instrumentation-express já abre os spans das camadas, e
    // esta repetiria cada um (`request handler` em dobro, `middleware - patched`).
    "@opentelemetry/instrumentation-router": { enabled: false },
  }),
  // Saúde, drenagem e métricas (ou os `ignorePaths` do `observeHttp`) ficam fora do trace.
  new HttpInstrumentation({
    requestHook: saveIncomingSpan,
    ignoreIncomingRequestHook: isIgnoredRequest,
  }),
  new ExpressInstrumentation(),
  ...config.instrumentations,
];

/** Origem dos endpoints OTLP: o `fetch` para eles não é observado (exportar não gera span). */
const buildIgnoreUrl = (config: ResolvedObservabilityOptions) => {
  const origens = new Set(
    [config.tracesEndpoint, config.metricsEndpoint].flatMap((endpoint) => {
      try {
        return [new URL(endpoint).origin];
      } catch {
        return [];
      }
    }),
  );
  return (url: URL) => origens.has(url.origin);
};

/**
 * O `https` vem antes do `http`, sempre. No Bun, o `https.Server` herda do `http.Server` (no Node,
 * herda do `tls.Server`), e o `emit` que ele herda é o já embrulhado pela instrumentation-http. Ao
 * enganchar o `https`, o `_wrap` do OpenTelemetry vê o embrulho e chama o `_unwrap` antes de
 * embrulhar de novo; o `__unwrap` do shimmer devolve o `emit` original ao DONO do embrulho, o
 * `http.Server`. Resultado: o primeiro `require("https")` depois do `http` (o axios faz, pelo
 * follow-redirects) deixava todo servidor HTTP sem span SERVER e sem os spans do Express. Com o
 * `https` primeiro, ele embrulha o `emit` que herda do `EventEmitter`, e o do `http` fica intacto.
 */
const MODULOS_ANTES_DO_HTTP = ["https"];

/** Carrega pelo `require`, a partir do script de entrada do projeto. Módulo ausente é ignorado. */
const preRequireModules = (modulos: readonly string[]): void => {
  const require = createRequire(Bun.main || path.join(process.cwd(), "index.js"));
  for (const modulo of modulos) {
    try {
      require(modulo);
    } catch {
      // O projeto não usa este módulo: nada a instrumentar.
    }
  }
};

// ── Handle ────────────────────────────────────────────────────────────────────────────────────

interface Partes {
  enabled: boolean;
  processors: SpanProcessor[];
  readers: IMetricReader[];
  sdk?: NodeSDK;
  restores: Array<() => void>;
}

const buildHandle = (partes: Partes): ObservabilityHandle => {
  let encerrando: Promise<void> | undefined;
  const forceFlush = async () => {
    await Promise.all([
      ...partes.processors.map((processor) => processor.forceFlush()),
      ...partes.readers.map((reader) => reader.forceFlush()),
    ]);
  };
  // Desliga o SDK antes de desfazer o resto: a coleta final ainda lê os gauges registrados.
  const runShutdown = async () => {
    await partes.sdk?.shutdown();
    for (const restore of partes.restores) restore();
  };
  return {
    enabled: partes.enabled,
    forceFlush,
    shutdown: () => {
      encerrando ??= runShutdown();
      return encerrando;
    },
  };
};

const startSdk = (config: ResolvedObservabilityOptions, restores: Array<() => void>): Partes => {
  diag.setLogger(quietDiagLogger, DiagLogLevel.ERROR);
  const processors = buildSpanProcessors(config);
  const readers = buildMetricReaders(config);
  const sdk = new NodeSDK({
    resource: buildResource(config),
    spanProcessors: processors,
    metricReaders: readers,
    views: buildViews(),
    instrumentations: buildInstrumentations(config),
    textMapPropagator: buildTextMapPropagator(),
  });
  sdk.start();
  // Depois do start: os gauges só ganham o MeterProvider de verdade quando ele já é o global.
  restores.push(registerDefaultMetrics());
  preRequireModules([...MODULOS_ANTES_DO_HTTP, ...config.preRequire]);
  if (config.instrumentFetch) {
    restores.push(
      instrumentFetch({
        tracer: trace.getTracer(METER_NAME),
        meter: metrics.getMeter(METER_NAME),
        ignoreUrl: buildIgnoreUrl(config),
      }),
    );
  }
  return { enabled: true, processors, readers, sdk, restores };
};

const startDisabled = (restores: Array<() => void>): Partes => ({
  enabled: false,
  processors: [],
  readers: [],
  restores,
});

/**
 * Sobe a observabilidade uma vez por processo: a segunda chamada devolve o mesmo handle. O
 * encerramento (descarregar e desligar) é um gancho do `onShutdown`, o último da fila.
 */
export function startObservability(options: ObservabilityOptions = {}): ObservabilityHandle {
  if (_handle) return _handle;
  const config = resolveObservabilityOptions(options, process.env);
  configureLogger({ service: config.serviceName, env: config.environment });

  const restores: Array<() => void> = config.patchConsole ? [patchConsole()] : [];
  const partes = config.enabled ? startSdk(config, restores) : startDisabled(restores);
  const handle = buildHandle(partes);
  onShutdown("observabilidade", () => handle.shutdown(), { order: config.shutdownOrder });
  _handle = handle;
  logger.info("[otel] observabilidade iniciada", {
    otel_enabled: config.enabled,
    traces: config.enabled ? config.tracesEndpoint : undefined,
    metrics: config.enabled ? config.metricsEndpoint : undefined,
  });
  return handle;
}

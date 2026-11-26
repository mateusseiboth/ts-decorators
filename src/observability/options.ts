/**
 * Opções do `startObservability`: a opção vence, a env preenche o que faltou, e o resto é o
 * default da especificação.
 */
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace";

/** Uma instrumentação do OpenTelemetry (ou uma lista delas), como o `NodeSDK` aceita. */
export type ObservabilityInstrumentation = NodeSDKConfiguration["instrumentations"][number];

/** `otlp` manda para o coletor (gRPC, gzip); `console` imprime; `none` não exporta. */
export type ExporterKind = "otlp" | "console" | "none";

export interface ObservabilityOptions {
  /** Liga o SDK. Default: `OTEL_ENABLED` (o legado `OTEL_TRACING_ENABLED="false"` também desliga). */
  enabled?: boolean;
  /** `service.name`. Default: `OTEL_SERVICE_NAME`; obrigatório com o SDK ligado. */
  serviceName?: string;
  /** `service.version`. Default: `OTEL_SERVICE_VERSION`, a versão do package.json ou `0.0.0`. */
  serviceVersion?: string;
  /** `deployment.environment.name`. Default: `DEPLOY_ENV`, `NODE_ENV` ou `development`. */
  environment?: string;
  /** Default: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT` ou `http://localhost:4317`. */
  tracesEndpoint?: string;
  /** Default: `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT` ou `http://localhost:4317`. */
  metricsEndpoint?: string;
  /** Para onde vão os spans: um tipo ou um exportador pronto. Default: `OTEL_TRACES_EXPORTER` ou `otlp`. */
  traceExporter?: ExporterKind | SpanExporter;
  /** Para onde vão as métricas. Default: `OTEL_METRICS_EXPORTER` ou `otlp`. */
  metricExporter?: ExporterKind | PushMetricExporter;
  /** Intervalo de exportação das métricas, em ms. Default: `OTEL_METRIC_EXPORT_INTERVAL` ou 15000. */
  metricExportIntervalMs?: number;
  /** Spans por lote enviado. Default: `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` ou 20. */
  maxExportBatchSize?: number;
  /** Spans na fila antes de descartar. Default: `OTEL_BSP_MAX_QUEUE_SIZE` ou 512. */
  maxQueueSize?: number;
  /** `console.log/info/warn/error/debug` saem no formato do logger. Default: `true`. */
  patchConsole?: boolean;
  /** Span CLIENT e propagação no `fetch` global. Default: `true`. */
  instrumentFetch?: boolean;
  /**
   * Módulos carregados pelo `require` logo depois do SDK, para o `import` do projeto receber a
   * cópia instrumentada. O `https` é carregado antes deles, sempre. Default: `["http", "express"]`.
   */
  preRequire?: string[];
  /** Instrumentações a mais, além das automáticas, da HTTP e da Express. */
  instrumentations?: ObservabilityInstrumentation[];
  /** `order` do gancho de desligamento que descarrega e encerra o SDK. Default: o último. */
  shutdownOrder?: number;
}

export type ResolvedObservabilityOptions = Required<ObservabilityOptions>;

type Env = Record<string, string | undefined>;

const DEFAULT_ENDPOINT = "http://localhost:4317";
const EXPORTER_KINDS: readonly ExporterKind[] = ["otlp", "console", "none"];
const SEM_NOME = "unknown_service";
const MENSAGEM_SEM_NOME = "Informe OTEL_SERVICE_NAME ou a opção serviceName do startObservability.";

const readText = (env: Env, ...nomes: string[]): string | undefined =>
  nomes.map((nome) => env[nome]).find((valor) => valor !== undefined && valor !== "");

const readNumber = (env: Env, nome: string): number | undefined => {
  const numero = Number(env[nome]);
  return env[nome] && Number.isFinite(numero) && numero > 0 ? numero : undefined;
};

const readExporterKind = (env: Env, nome: string): ExporterKind | undefined => {
  const valor = env[nome]?.toLowerCase() as ExporterKind | undefined;
  return valor && EXPORTER_KINDS.includes(valor) ? valor : undefined;
};

const isDesligadoNaEnv = (env: Env): boolean =>
  [env.OTEL_ENABLED, env.OTEL_TRACING_ENABLED].some((valor) => valor?.toLowerCase() === "false");

const resolveServiceName = (enabled: boolean, nome: string | undefined): string => {
  if (nome) return nome;
  if (enabled) throw new Error(MENSAGEM_SEM_NOME);
  return SEM_NOME;
};

export function resolveObservabilityOptions(
  options: ObservabilityOptions,
  env: Env,
): ResolvedObservabilityOptions {
  const enabled = options.enabled ?? !isDesligadoNaEnv(env);
  return {
    enabled,
    serviceName: resolveServiceName(
      enabled,
      options.serviceName ?? readText(env, "OTEL_SERVICE_NAME"),
    ),
    serviceVersion:
      options.serviceVersion ??
      readText(env, "OTEL_SERVICE_VERSION", "npm_package_version") ??
      "0.0.0",
    environment: options.environment ?? readText(env, "DEPLOY_ENV", "NODE_ENV") ?? "development",
    tracesEndpoint:
      options.tracesEndpoint ??
      readText(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT") ??
      DEFAULT_ENDPOINT,
    metricsEndpoint:
      options.metricsEndpoint ??
      readText(env, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT") ??
      DEFAULT_ENDPOINT,
    traceExporter: options.traceExporter ?? readExporterKind(env, "OTEL_TRACES_EXPORTER") ?? "otlp",
    metricExporter:
      options.metricExporter ?? readExporterKind(env, "OTEL_METRICS_EXPORTER") ?? "otlp",
    metricExportIntervalMs:
      options.metricExportIntervalMs ?? readNumber(env, "OTEL_METRIC_EXPORT_INTERVAL") ?? 15_000,
    maxExportBatchSize:
      options.maxExportBatchSize ?? readNumber(env, "OTEL_BSP_MAX_EXPORT_BATCH_SIZE") ?? 20,
    maxQueueSize: options.maxQueueSize ?? readNumber(env, "OTEL_BSP_MAX_QUEUE_SIZE") ?? 512,
    patchConsole: options.patchConsole ?? true,
    instrumentFetch: options.instrumentFetch ?? true,
    preRequire: options.preRequire ?? ["http", "express"],
    instrumentations: options.instrumentations ?? [],
    shutdownOrder: options.shutdownOrder ?? Number.MAX_SAFE_INTEGER,
  };
}

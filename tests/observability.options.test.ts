import { describe, expect, test } from "bun:test";

import { resolveObservabilityOptions } from "../src/observability/options";

const BASE = { OTEL_SERVICE_NAME: "api" };

describe("opções do startObservability", () => {
  test("defaults da especificação", () => {
    expect(resolveObservabilityOptions({}, BASE)).toEqual({
      enabled: true,
      serviceName: "api",
      serviceVersion: "0.0.0",
      environment: "development",
      tracesEndpoint: "http://localhost:4317",
      metricsEndpoint: "http://localhost:4317",
      traceExporter: "otlp",
      metricExporter: "otlp",
      metricExportIntervalMs: 15_000,
      maxExportBatchSize: 20,
      maxQueueSize: 512,
      patchConsole: true,
      instrumentFetch: true,
      preRequire: ["http", "express"],
      instrumentations: [],
      shutdownOrder: Number.MAX_SAFE_INTEGER,
    });
  });

  test("as envs preenchem o que a opção não trouxe", () => {
    const config = resolveObservabilityOptions(
      {},
      {
        ...BASE,
        OTEL_SERVICE_VERSION: "1.2.3",
        DEPLOY_ENV: "homologacao",
        NODE_ENV: "production",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://otel:4317",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://otel-metrics:4317",
        OTEL_METRIC_EXPORT_INTERVAL: "5000",
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "50",
        OTEL_BSP_MAX_QUEUE_SIZE: "2048",
        OTEL_TRACES_EXPORTER: "console",
        OTEL_METRICS_EXPORTER: "none",
      },
    );
    expect(config).toMatchObject({
      serviceVersion: "1.2.3",
      environment: "homologacao",
      tracesEndpoint: "http://otel:4317",
      metricsEndpoint: "http://otel-metrics:4317",
      metricExportIntervalMs: 5000,
      maxExportBatchSize: 50,
      maxQueueSize: 2048,
      traceExporter: "console",
      metricExporter: "none",
    });
  });

  test("a opção vence a env", () => {
    const config = resolveObservabilityOptions(
      { serviceName: "worker", environment: "production", metricExportIntervalMs: 1000 },
      { ...BASE, DEPLOY_ENV: "homologacao", OTEL_METRIC_EXPORT_INTERVAL: "5000" },
    );
    expect(config).toMatchObject({
      serviceName: "worker",
      environment: "production",
      metricExportIntervalMs: 1000,
    });
  });

  test("versão cai para a do package.json do processo, e o ambiente para o NODE_ENV", () => {
    const config = resolveObservabilityOptions(
      {},
      { ...BASE, npm_package_version: "4.5.6", NODE_ENV: "production" },
    );
    expect(config).toMatchObject({ serviceVersion: "4.5.6", environment: "production" });
  });

  test("OTEL_EXPORTER_OTLP_ENDPOINT vale para os dois sinais", () => {
    const config = resolveObservabilityOptions(
      {},
      { ...BASE, OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4317" },
    );
    expect(config).toMatchObject({
      tracesEndpoint: "http://collector:4317",
      metricsEndpoint: "http://collector:4317",
    });
  });

  test.each([
    [{ OTEL_ENABLED: "false" }],
    [{ OTEL_TRACING_ENABLED: "false" }],
    [{ OTEL_ENABLED: "FALSE" }],
  ])("%o desliga", (env) => {
    expect(resolveObservabilityOptions({}, { ...BASE, ...env }).enabled).toBe(false);
  });

  test("enabled: true na opção vence a env desligada", () => {
    expect(
      resolveObservabilityOptions({ enabled: true }, { ...BASE, OTEL_ENABLED: "false" }).enabled,
    ).toBe(true);
  });

  test("número inválido na env cai no default", () => {
    expect(
      resolveObservabilityOptions({}, { ...BASE, OTEL_METRIC_EXPORT_INTERVAL: "abc" })
        .metricExportIntervalMs,
    ).toBe(15_000);
  });

  test("exportador desconhecido na env cai no otlp", () => {
    expect(
      resolveObservabilityOptions({}, { ...BASE, OTEL_TRACES_EXPORTER: "zipkin" }).traceExporter,
    ).toBe("otlp");
  });

  test("ligado e sem nome do serviço: erro que diz o que fazer", () => {
    expect(() => resolveObservabilityOptions({}, {})).toThrow(
      "Informe OTEL_SERVICE_NAME ou a opção serviceName do startObservability.",
    );
  });

  test("desligado não exige o nome do serviço", () => {
    expect(resolveObservabilityOptions({}, { OTEL_ENABLED: "false" }).serviceName).toBe(
      "unknown_service",
    );
  });
});

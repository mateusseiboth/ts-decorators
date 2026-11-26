/**
 * Coletor de métricas para os testes: um MeterProvider do SDK registrado como global, com um
 * leitor que coleta sob demanda. O `bun test` roda todos os arquivos num processo só: cada teste
 * sobe o seu e desliga no fim (`metrics.disable()`), senão o provider vaza para o próximo.
 */
import { metrics } from "@opentelemetry/api";
import {
  DataPointType,
  MeterProvider,
  MetricReader,
  type DataPoint,
  type Histogram,
  type MetricData,
} from "@opentelemetry/sdk-metrics";

class LeitorDeTeste extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

export type Atributos = Record<string, unknown>;

export interface PontoSimples {
  attributes: Atributos;
  value: number;
}

export interface PontoDeHistograma {
  attributes: Atributos;
  count: number;
  sum: number;
  boundaries: number[];
}

export interface Coletor {
  provider: MeterProvider;
  collect(): Promise<MetricData[]>;
  /** A métrica pelo nome, ou `undefined` quando nada foi gravado nela. */
  find(name: string): Promise<MetricData | undefined>;
  /** Os pontos de contador ou gauge. */
  points(name: string): Promise<PontoSimples[]>;
  /** Os pontos de histograma. */
  histogram(name: string): Promise<PontoDeHistograma[]>;
  stop(): Promise<void>;
}

const toPontoSimples = (ponto: DataPoint<unknown>): PontoSimples => ({
  attributes: ponto.attributes,
  value: ponto.value as number,
});

const toPontoDeHistograma = (ponto: DataPoint<unknown>): PontoDeHistograma => {
  const valor = ponto.value as Histogram;
  return {
    attributes: ponto.attributes,
    count: valor.count,
    sum: valor.sum ?? 0,
    boundaries: valor.buckets.boundaries,
  };
};

/** Os valores em texto, em ordem alfabética (a ordem dos pontos não é contrato). */
export const sortTextos = (valores: unknown[]): string[] =>
  valores.map(String).sort((a, b) => a.localeCompare(b));

/** Sobe um provider novo e o registra como global. */
export function startColetor(): Coletor {
  const reader = new LeitorDeTeste();
  const provider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);

  const collect = async () => {
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
  };
  const find = async (name: string) =>
    (await collect()).find((metrica) => metrica.descriptor.name === name);
  const dataPoints = async (name: string) =>
    ((await find(name))?.dataPoints ?? []) as DataPoint<unknown>[];

  return {
    provider,
    collect,
    find,
    points: async (name) => (await dataPoints(name)).map(toPontoSimples),
    histogram: async (name) => {
      const metrica = await find(name);
      if (metrica && metrica.dataPointType !== DataPointType.HISTOGRAM) {
        throw new Error(`${name} não é histograma.`);
      }
      return (await dataPoints(name)).map(toPontoDeHistograma);
    },
    stop: async () => {
      metrics.disable();
      await provider.shutdown();
    },
  };
}

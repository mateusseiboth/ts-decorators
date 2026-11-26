/**
 * Métricas do OpenTelemetry pelo ponto de entrada principal: histograma, contador e gauge, sem
 * importar o `@opentelemetry/api` (ele é opcional, ver `otelApi.ts`).
 *
 * - Sem a API instalada ou sem SDK registrado, tudo é no-op.
 * - O instrumento nasce na PRIMEIRA gravação e fica guardado por MeterProvider. A API não tem um
 *   provider substituto que repassa ao SDK que chega depois (como faz com os traces): o
 *   instrumento criado antes do SDK seria no-op para sempre. Por isso cada gravação confere o
 *   provider global, e a troca dele joga fora os instrumentos e religa os gauges.
 * - Métrica nunca derruba quem mede: erro de gravação ou de observação vai para o log.
 *
 * Uso:
 *   recordMetric({ name: "app.remessa.duration", value: segundos, unit: "s" });
 *   incrementMetric({ name: "app.boleto.emitido", attributes: { banco: "001" } });
 *   registerGauge({ name: "app.remessa.pendente", observe: () => fila.length });
 */

import { logger } from "../functions/logger";
import { getHandlerContext, hasTenant } from "../handlers/context";
import { BUCKETS_PADRAO } from "./buckets";
import { getOtelApi } from "./otelApi";

/** Atributos (rótulos) de um ponto. Sempre de cardinalidade baixa: nada de id, path ou mensagem. */
export type MetricAttributes = Record<string, string | number | boolean>;

export interface MetricInstrumentOptions {
  /** Nome do instrumento (`app.remessa.duration`). */
  name: string;
  /** Unidade UCUM (`s`, `By`, `{job}`). Vale na criação do instrumento. */
  unit?: string;
  /** Descrição do instrumento. Vale na criação. */
  description?: string;
}

export interface RecordMetricOptions extends MetricInstrumentOptions {
  /** O valor medido (duração em segundos, tamanho em bytes...). */
  value: number;
  attributes?: MetricAttributes;
  /**
   * Limites dos buckets. Default: os de `BUCKETS_PADRAO` para o nome, senão os do SDK. Vale na
   * criação do instrumento: o primeiro registro do nome decide.
   */
  buckets?: number[];
}

export interface IncrementMetricOptions extends MetricInstrumentOptions {
  /** Quanto somar. Default: 1. */
  value?: number;
  attributes?: MetricAttributes;
}

/** Um ponto observado por um gauge. */
export interface GaugeObservation {
  value: number;
  attributes?: MetricAttributes;
}

export interface RegisterGaugeOptions extends MetricInstrumentOptions {
  /** Chamada a cada coleta do SDK. Devolve um valor, ou um ponto por combinação de atributos. */
  observe: () => number | GaugeObservation[] | Promise<number | GaugeObservation[]>;
}

// Só o que o pacote usa da API de métricas. Os tipos do `@opentelemetry/api` não entram.
interface InstrumentConfig {
  unit?: string;
  description?: string;
  advice?: { explicitBucketBoundaries?: number[] };
}
interface ObservableResultLike {
  observe(value: number, attributes?: MetricAttributes): void;
}
type ObservableCallbackLike = (result: ObservableResultLike) => void | Promise<void>;
interface HistogramLike {
  record(value: number, attributes?: MetricAttributes): void;
}
interface CounterLike {
  add(value: number, attributes?: MetricAttributes): void;
}
interface ObservableLike {
  addCallback(callback: ObservableCallbackLike): void;
  removeCallback(callback: ObservableCallbackLike): void;
}
interface MeterLike {
  createHistogram(name: string, config?: InstrumentConfig): HistogramLike;
  createCounter(name: string, config?: InstrumentConfig): CounterLike;
  createObservableGauge(name: string, config?: InstrumentConfig): ObservableLike;
  createObservableCounter(name: string, config?: InstrumentConfig): ObservableLike;
}
interface MeterProviderLike {
  getMeter(name: string): MeterLike;
}
interface MetricsApiLike {
  metrics?: { getMeterProvider(): MeterProviderLike };
}

/** O meter de tudo que o pacote mede. */
const METER = "@mateusseiboth/ts-decorators";

type TipoDeObservavel = "observableGauge" | "observableCounter";
type TipoDeInstrumento = "histogram" | "counter" | TipoDeObservavel;

interface TiposCriados {
  histogram: HistogramLike;
  counter: CounterLike;
  observableGauge: ObservableLike;
  observableCounter: ObservableLike;
}

const CRIADORES: {
  [T in TipoDeInstrumento]: (
    meter: MeterLike,
    name: string,
    config: InstrumentConfig,
  ) => TiposCriados[T];
} = {
  histogram: (meter, name, config) => meter.createHistogram(name, config),
  counter: (meter, name, config) => meter.createCounter(name, config),
  observableGauge: (meter, name, config) => meter.createObservableGauge(name, config),
  observableCounter: (meter, name, config) => meter.createObservableCounter(name, config),
};

interface Observavel {
  tipo: TipoDeObservavel;
  name: string;
  config: InstrumentConfig;
  callback: ObservableCallbackLike;
  /** O instrumento do provider atual em que o callback está ligado. */
  ligado?: ObservableLike;
}

let _provider: MeterProviderLike | undefined;
let _meter: MeterLike | undefined;
const _instrumentos = new Map<string, unknown>();
const _observaveis = new Set<Observavel>();

const readProvider = (): MeterProviderLike | undefined =>
  (getOtelApi() as MetricsApiLike | null)?.metrics?.getMeterProvider();

const buildConfig = ({ unit, description }: MetricInstrumentOptions): InstrumentConfig => ({
  ...(unit === undefined ? {} : { unit }),
  ...(description === undefined ? {} : { description }),
});

/** O instrumento do meter atual, criado na primeira vez que o nome aparece. */
function findOrCreate<T extends TipoDeInstrumento>(
  meter: MeterLike,
  tipo: T,
  name: string,
  config: InstrumentConfig,
): TiposCriados[T] {
  const chave = `${tipo}:${name}`;
  const existente = _instrumentos.get(chave) as TiposCriados[T] | undefined;
  if (existente) return existente;
  const criado = CRIADORES[tipo](meter, name, config);
  _instrumentos.set(chave, criado);
  return criado;
}

function bindObservavel(observavel: Observavel): void {
  if (!_meter) return;
  const { tipo, name, config, callback } = observavel;
  observavel.ligado = findOrCreate(_meter, tipo, name, config);
  observavel.ligado.addCallback(callback);
}

function unbindObservavel(observavel: Observavel): void {
  observavel.ligado?.removeCallback(observavel.callback);
  observavel.ligado = undefined;
}

/** O meter do provider global de agora; troca de provider refaz instrumentos e gauges. */
function resolveMeter(): MeterLike | undefined {
  const provider = readProvider();
  if (provider === _provider) return _meter;
  for (const observavel of _observaveis) unbindObservavel(observavel);
  _instrumentos.clear();
  _provider = provider;
  _meter = provider?.getMeter(METER);
  for (const observavel of _observaveis) bindObservavel(observavel);
  return _meter;
}

function getInstrumento<T extends TipoDeInstrumento>(
  tipo: T,
  name: string,
  config: InstrumentConfig,
): TiposCriados[T] | undefined {
  const meter = resolveMeter();
  return meter && findOrCreate(meter, tipo, name, config);
}

/** Gravação que falha vai para o log: quem mede não pode cair por causa da métrica. */
function runSeguro(name: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    logger.error(`[@mateusseiboth/ts-decorators] Métrica ${name}: a gravação falhou:`, err);
  }
}

const buildHistogramConfig = (options: RecordMetricOptions): InstrumentConfig => {
  const buckets = options.buckets ?? BUCKETS_PADRAO[options.name];
  const advice = buckets ? { advice: { explicitBucketBoundaries: [...buckets] } } : {};
  return { ...buildConfig(options), ...advice };
};

/** Grava um valor num histograma. */
export function recordMetric(options: RecordMetricOptions): void {
  runSeguro(options.name, () =>
    getInstrumento("histogram", options.name, buildHistogramConfig(options))?.record(
      options.value,
      options.attributes,
    ),
  );
}

/** Soma num contador. */
export function incrementMetric(options: IncrementMetricOptions): void {
  runSeguro(options.name, () =>
    getInstrumento("counter", options.name, buildConfig(options))?.add(
      options.value ?? 1,
      options.attributes,
    ),
  );
}

const toObservacoes = (valor: number | GaugeObservation[]): GaugeObservation[] =>
  typeof valor === "number" ? [{ value: valor }] : valor;

const buildCallback =
  (name: string, observe: RegisterGaugeOptions["observe"]): ObservableCallbackLike =>
  async (result) => {
    try {
      for (const { value, attributes } of toObservacoes(await observe())) {
        result.observe(value, attributes);
      }
    } catch (err) {
      logger.error(`[@mateusseiboth/ts-decorators] Métrica ${name}: a observação falhou:`, err);
    }
  };

/**
 * Liga um instrumento observável: o callback roda a cada coleta do SDK. Interno: o
 * `registerGauge` público e as métricas do processo (`process.cpu.time` é contador observável).
 */
export function registerObservable(
  tipo: TipoDeObservavel,
  options: RegisterGaugeOptions,
): () => void {
  const observavel: Observavel = {
    tipo,
    name: options.name,
    config: buildConfig(options),
    callback: buildCallback(options.name, options.observe),
  };
  resolveMeter();
  _observaveis.add(observavel);
  bindObservavel(observavel);
  return () => {
    unbindObservavel(observavel);
    _observaveis.delete(observavel);
  };
}

/** Gauge observado a cada coleta; devolve a função que o desliga. */
export function registerGauge(options: RegisterGaugeOptions): () => void {
  return registerObservable("observableGauge", options);
}

/**
 * O rótulo `tenant` do contexto atual, em texto: `{ tenant: "79" }`. Sem tenant (fora de
 * requisição, `0`, texto vazio), objeto vazio: o rótulo fica de fora, nunca vazio.
 */
export function getTenantLabel(): MetricAttributes {
  const tenant = getHandlerContext()?.entity;
  return hasTenant(tenant) ? { tenant: String(tenant) } : {};
}

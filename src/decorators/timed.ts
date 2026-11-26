/**
 * @Timed: mede a duração de cada chamada do método e guarda as estatísticas em memória
 * (contagem, erros, mínimo, máximo, percentis). `onTiming` repassa cada amostra para fora (log,
 * Prometheus). Com o OpenTelemetry, cada chamada também vira um ponto do histograma
 * `app.method.duration` (segundos), com `code.function`, `outcome` e o tenant do contexto.
 *
 * Uso:
 *   @Timed({ slowMs: 500, labels: (tipo) => ({ tipo }) })
 *   async calcularIptu(tipo, imovelId) { ... }
 */

import { logger } from "../functions/logger";
import { METRICA, toOutcome } from "../observability/catalog";
import { recordMetric, type MetricAttributes } from "../observability/metrics";
import { makeMethodDecorator } from "./_method";
import {
  buildCodeFunction,
  buildMethodAttributes,
  runObservado,
  type MethodMetricOptions,
} from "./_methodMetrics";

export interface TimedOptions extends MethodMetricOptions {
  /** Acima disto, a chamada sai no log como lenta (warn). */
  slowMs?: number;
  /**
   * Limites dos buckets do histograma, em segundos. Pede `metric`: o instrumento padrão
   * (`app.method.duration`) é um só para todos os métodos, com os buckets de `BUCKETS_HTTP`.
   */
  buckets?: number[];
}

export interface TimingSample {
  name: string;
  durationMs: number;
  ok: boolean;
}

export interface TimingStats {
  name: string;
  count: number;
  errors: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  /** Percentis das últimas 1.000 chamadas. */
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/** Quantas durações recentes entram no cálculo dos percentis. */
const JANELA_DOS_PERCENTIS = 1000;

interface Acumulado {
  count: number;
  errors: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  /** Buffer circular: a amostra `n` ocupa a posição `n % JANELA_DOS_PERCENTIS`. */
  recentes: number[];
}

type Ouvinte = (sample: TimingSample) => void;

const _acumulados = new Map<string, Acumulado>();
const _ouvintes = new Set<Ouvinte>();

const createAcumulado = (): Acumulado => ({
  count: 0,
  errors: 0,
  totalMs: 0,
  minMs: Number.POSITIVE_INFINITY,
  maxMs: 0,
  recentes: [],
});

const getAcumulado = (name: string): Acumulado => {
  const existente = _acumulados.get(name);
  if (existente) return existente;
  const novo = createAcumulado();
  _acumulados.set(name, novo);
  return novo;
};

const saveAmostra = ({ name, durationMs, ok }: TimingSample): void => {
  const acumulado = getAcumulado(name);
  acumulado.recentes[acumulado.count % JANELA_DOS_PERCENTIS] = durationMs;
  acumulado.count++;
  acumulado.errors += ok ? 0 : 1;
  acumulado.totalMs += durationMs;
  acumulado.minMs = Math.min(acumulado.minMs, durationMs);
  acumulado.maxMs = Math.max(acumulado.maxMs, durationMs);
};

const notifyOuvinte = (ouvinte: Ouvinte, amostra: TimingSample): void => {
  // Quem exporta a métrica não pode derrubar a chamada medida.
  try {
    ouvinte(amostra);
  } catch (err) {
    logger.error(
      `[@mateusseiboth/ts-decorators] @Timed: o ouvinte de onTiming falhou em ${amostra.name}:`,
      err,
    );
  }
};

const warnLenta = (amostra: TimingSample, slowMs: number | undefined): void => {
  if (slowMs === undefined || amostra.durationMs <= slowMs) return;
  logger.warn(
    `[@mateusseiboth/ts-decorators] @Timed: ${amostra.name} levou ${amostra.durationMs.toFixed(1)} ms (limite ${slowMs} ms).`,
  );
};

const recordAmostra = (amostra: TimingSample, slowMs: number | undefined): void => {
  saveAmostra(amostra);
  warnLenta(amostra, slowMs);
  for (const ouvinte of _ouvintes) notifyOuvinte(ouvinte, amostra);
};

/** Percentil pela posição mais próxima: o menor valor que cobre `p`% das amostras. */
const findPercentil = (ordenadas: readonly number[], p: number): number =>
  ordenadas[Math.max(0, Math.ceil((p / 100) * ordenadas.length) - 1)] ?? 0;

const buildStats = (name: string, acumulado: Acumulado): TimingStats => {
  const ordenadas = [...acumulado.recentes].sort((a, b) => a - b);
  return {
    name,
    count: acumulado.count,
    errors: acumulado.errors,
    totalMs: acumulado.totalMs,
    minMs: acumulado.minMs,
    maxMs: acumulado.maxMs,
    p50Ms: findPercentil(ordenadas, 50),
    p95Ms: findPercentil(ordenadas, 95),
    p99Ms: findPercentil(ordenadas, 99),
  };
};

/** O ponto do histograma do OpenTelemetry: a mesma duração, em segundos. */
const recordPonto = (
  options: TimedOptions | undefined,
  amostra: TimingSample,
  attributes: MetricAttributes,
): void =>
  recordMetric({
    ...METRICA.METHOD_DURATION,
    name: options?.metric ?? METRICA.METHOD_DURATION.name,
    value: amostra.durationMs / 1000,
    buckets: options?.buckets,
    attributes: { ...attributes, outcome: toOutcome(amostra.ok) },
  });

/** Executa e mede: a amostra vai para as estatísticas, para os ouvintes e para o histograma. */
const runMedido = (
  name: string,
  options: TimedOptions | undefined,
  attributes: MetricAttributes,
  run: () => unknown,
): unknown => {
  const inicio = performance.now();
  return runObservado(run, (ok) => {
    const amostra = { name, durationMs: performance.now() - inicio, ok };
    recordAmostra(amostra, options?.slowMs);
    recordPonto(options, amostra, attributes);
  });
};

/** Buckets próprios num instrumento compartilhado não teriam efeito: falha na declaração. */
const requireMetricDosBuckets = (options: TimedOptions | undefined): void => {
  if (!options?.buckets || options.metric) return;
  throw new TypeError(
    "[@mateusseiboth/ts-decorators] @Timed: buckets próprios pedem um metric próprio (o app.method.duration é compartilhado).",
  );
};

export function Timed(options?: TimedOptions): (...args: any[]) => any {
  requireMetricDosBuckets(options);
  return makeMethodDecorator("Timed", (original, methodName) => {
    return function (this: any, ...args: any[]) {
      const name = buildCodeFunction(this, methodName, options);
      const attributes = buildMethodAttributes("@Timed", name, options, args);
      return runMedido(name, options, attributes, () => original.apply(this, args));
    };
  });
}

/** As estatísticas de cada métrica medida, em ordem de nome. */
export function getTimings(): TimingStats[] {
  return [..._acumulados]
    .map(([name, acumulado]) => buildStats(name, acumulado))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Assina as amostras; devolve a função que cancela a assinatura. */
export function onTiming(listener: (sample: TimingSample) => void): () => void {
  _ouvintes.add(listener);
  return () => {
    _ouvintes.delete(listener);
  };
}

/**
 * Zera as estatísticas. Os ouvintes de `onTiming` continuam assinados: quem exporta as métricas
 * se registra uma vez, na subida, e zerar os números não pode desligar a exportação.
 */
export function clearTimings(): void {
  _acumulados.clear();
}

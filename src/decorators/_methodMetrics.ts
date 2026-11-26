/**
 * O que o @Timed e o @Counted têm em comum: o nome da chamada (`code.function`), os rótulos que
 * vêm dos argumentos e do contexto, e o envelope que avisa quando a chamada termina, síncrona ou
 * não.
 */

import { logger } from "../functions/logger";
import { getTenantLabel, type MetricAttributes } from "../observability/metrics";

export interface MethodMetricOptions {
  /** O `code.function` dos pontos (e o nome no `getTimings`). Default: `Classe.metodo`. */
  name?: string;
  /** Rótulos a partir dos argumentos da chamada. Cardinalidade baixa: nada de id. */
  labels?: (...args: any[]) => MetricAttributes;
  /** Leva o rótulo `tenant` do contexto, quando houver. Default: true. */
  tenant?: boolean;
  /** Nome do instrumento OpenTelemetry. Default: o do decorator. */
  metric?: string;
}

export const buildCodeFunction = (
  instance: unknown,
  methodName: string,
  options: MethodMetricOptions | undefined,
): string =>
  options?.name ?? `${(instance as object | undefined)?.constructor?.name ?? "fn"}.${methodName}`;

/** Rótulo que lança não derruba a chamada medida: o ponto sai sem eles. */
const readLabels = (
  origem: string,
  name: string,
  options: MethodMetricOptions | undefined,
  args: unknown[],
): MetricAttributes => {
  try {
    return options?.labels?.(...args) ?? {};
  } catch (err) {
    logger.error(`[@mateusseiboth/ts-decorators] ${origem}: os rótulos de ${name} falharam:`, err);
    return {};
  }
};

/** Os rótulos da chamada; `code.function` vence o rótulo de mesmo nome. */
export const buildMethodAttributes = (
  origem: string,
  name: string,
  options: MethodMetricOptions | undefined,
  args: unknown[],
): MetricAttributes => ({
  ...readLabels(origem, name, options, args),
  ...(options?.tenant === false ? {} : getTenantLabel()),
  "code.function": name,
});

const isThenable = (valor: unknown): valor is PromiseLike<unknown> =>
  typeof (valor as PromiseLike<unknown> | undefined)?.then === "function";

/**
 * Executa e avisa `onEnd(ok)` quando termina. Retorno síncrono avisa na hora e volta como veio: o
 * método síncrono continua síncrono. Retorno thenable avisa quando termina. O erro é relançado.
 */
export function runObservado(run: () => unknown, onEnd: (ok: boolean) => void): unknown {
  let retorno: unknown;
  try {
    retorno = run();
  } catch (err) {
    onEnd(false);
    throw err;
  }

  if (!isThenable(retorno)) {
    onEnd(true);
    return retorno;
  }
  return retorno.then(
    (valor) => {
      onEnd(true);
      return valor;
    },
    (err: unknown) => {
      onEnd(false);
      throw err;
    },
  );
}

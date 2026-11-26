/**
 * @Counted: conta as chamadas do método no contador `app.method.calls` do OpenTelemetry, com
 * `code.function`, `outcome` (ok/erro), o tenant do contexto e os rótulos dos argumentos. Sem o
 * `@opentelemetry/api` ou sem SDK, só chama o método.
 *
 * Uso:
 *   @Counted({ labels: (origem) => ({ origem }) })
 *   async receberWebhook(origem, corpo) { ... }
 */

import { METRICA, toOutcome } from "../observability/catalog";
import { incrementMetric, type MetricAttributes } from "../observability/metrics";
import { makeMethodDecorator } from "./_method";
import {
  buildCodeFunction,
  buildMethodAttributes,
  runObservado,
  type MethodMetricOptions,
} from "./_methodMetrics";

export type CountedOptions = MethodMetricOptions;

const countChamada = (
  options: CountedOptions | undefined,
  attributes: MetricAttributes,
  ok: boolean,
): void =>
  incrementMetric({
    ...METRICA.METHOD_CALLS,
    name: options?.metric ?? METRICA.METHOD_CALLS.name,
    attributes: { ...attributes, outcome: toOutcome(ok) },
  });

export function Counted(options?: CountedOptions): (...args: any[]) => any {
  return makeMethodDecorator("Counted", (original, methodName) => {
    return function (this: any, ...args: any[]) {
      const name = buildCodeFunction(this, methodName, options);
      const attributes = buildMethodAttributes("@Counted", name, options, args);
      return runObservado(
        () => original.apply(this, args),
        (ok) => countChamada(options, attributes, ok),
      );
    };
  });
}

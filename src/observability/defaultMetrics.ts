/**
 * `registerDefaultMetrics`: liga os gauges do pacote (fila, drain, saúde) e as métricas do
 * processo. O `startObservability` chama na subida, depois de registrar o SDK; o app que monta o
 * SDK sozinho chama ele mesmo. Chamar de novo não liga nada duas vezes.
 */

import { getLastHealthResults } from "../decorators/healthCheck";
import { isDraining } from "../decorators/shutdown";
import { registerQueueGauges } from "../queue/gauges";
import { METRICA } from "./catalog";
import { registerGauge } from "./metrics";
import { JANELA_DO_EVENT_LOOP_MS, registerRuntimeMetrics } from "./runtimeMetrics";

export interface DefaultMetricsOptions {
  /** Métricas do processo: memória, CPU, uptime e atraso do event loop. Default: true. */
  runtime?: boolean;
  /** Janela da amostra do atraso do event loop, em ms. Default: 1000. */
  eventLoopSampleMs?: number;
}

const VALOR_DA_SONDA = { up: 1, down: 0 } as const;

const registerDrainGauge = () =>
  registerGauge({ ...METRICA.DRAIN_ACTIVE, observe: () => (isDraining() ? 1 : 0) });

const registerHealthGauge = () =>
  registerGauge({
    ...METRICA.HEALTH_CHECK,
    observe: () =>
      [...getLastHealthResults()].map(([check, status]) => ({
        value: VALOR_DA_SONDA[status],
        attributes: { check },
      })),
  });

const startRuntime = (options: DefaultMetricsOptions): Array<() => void> =>
  options.runtime === false
    ? []
    : [registerRuntimeMetrics(options.eventLoopSampleMs ?? JANELA_DO_EVENT_LOOP_MS)];

let _desligar: (() => void) | undefined;

/**
 * Liga as métricas padrão. Devolve a função que desliga todas; enquanto ela não for chamada, a
 * próxima chamada devolve a mesma função, sem ligar nada de novo.
 */
export function registerDefaultMetrics(options: DefaultMetricsOptions = {}): () => void {
  if (_desligar) return _desligar;
  const ligadas = [
    registerQueueGauges(),
    registerDrainGauge(),
    registerHealthGauge(),
    ...startRuntime(options),
  ];
  const desligar = () => {
    for (const desliga of ligadas) desliga();
    if (_desligar === desligar) _desligar = undefined;
  };
  _desligar = desligar;
  return desligar;
}

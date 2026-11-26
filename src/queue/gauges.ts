/**
 * Gauges da fila, lidos do `getQueueStats()` a cada coleta: `queue.jobs` (jobs no armazenamento,
 * por status) e `queue.jobs.in_flight` (em execução neste processo). Quem liga é o
 * `registerDefaultMetrics`.
 */

import { METRICA } from "../observability/catalog";
import { registerGauge, type GaugeObservation } from "../observability/metrics";
import { QUEUE_STATUSES } from "./adapter";
import { getQueueStats, type QueueStats } from "./registry";

const buildPorStatus = (stats: QueueStats[]): GaugeObservation[] =>
  stats.flatMap(({ name, counts }) =>
    QUEUE_STATUSES.map((status) => ({
      value: counts[status],
      attributes: { queue: name, status },
    })),
  );

const buildEmExecucao = (stats: QueueStats[]): GaugeObservation[] =>
  stats.map(({ name, inFlight }) => ({ value: inFlight, attributes: { queue: name } }));

/** Os gauges `queue.jobs` e `queue.jobs.in_flight`; devolve a função que os desliga. */
export function registerQueueGauges(): () => void {
  const desligar = [
    registerGauge({
      ...METRICA.QUEUE_JOBS,
      observe: async () => buildPorStatus(await getQueueStats()),
    }),
    registerGauge({
      ...METRICA.QUEUE_IN_FLIGHT,
      observe: async () => buildEmExecucao(await getQueueStats()),
    }),
  ];
  return () => {
    for (const desliga of desligar) desliga();
  };
}

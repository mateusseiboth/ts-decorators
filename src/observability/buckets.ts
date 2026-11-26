/**
 * Limites dos buckets dos histogramas (segundos; bytes nos de tamanho), por família e por instrumento.
 *
 * `BUCKETS_PADRAO` é a fonte das Views do SDK (`@mateusseiboth/ts-decorators/observability`) e do
 * `advice` que cada histograma leva na criação: com ou sem View, o p95 do Grafana sai dos mesmos
 * limites. Instrumento fora do registro fica com os buckets do SDK, ou com os que vierem na
 * gravação (`recordMetric({ buckets })`).
 */

/** Requisição HTTP e método medido (`@Timed`): de 5 ms a 60 s. */
export const BUCKETS_HTTP: number[] = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.35, 0.5, 0.75, 1, 1.5, 2.5, 5, 7.5, 10, 20,
  30, 60,
];

/** Banco (statement, transação, espera de trava): de 0,5 ms a 10 s. */
export const BUCKETS_DB: number[] = [
  0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Fila e relatório (execução e espera do job): de 50 ms a 30 min. */
export const BUCKETS_QUEUE: number[] = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1200, 1800,
];

/** Tamanho de corpo HTTP, em bytes: de 256 B a 64 MB (a mesma lista do gateway). */
export const BUCKETS_BYTES: number[] = [
  0, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
];

/** Os buckets de cada histograma conhecido, pelo nome do instrumento. */
export const BUCKETS_PADRAO: Record<string, number[]> = {
  "http.server.request.duration": BUCKETS_HTTP,
  "http.client.request.duration": BUCKETS_HTTP,
  "http.server.request.body.size": BUCKETS_BYTES,
  "http.server.response.body.size": BUCKETS_BYTES,
  "app.method.duration": BUCKETS_HTTP,
  "db.client.operation.duration": BUCKETS_DB,
  "db.client.transaction.duration": BUCKETS_DB,
  "app.advisory_lock.wait.duration": BUCKETS_DB,
  "process.event_loop.delay": BUCKETS_DB,
  "queue.job.duration": BUCKETS_QUEUE,
  "queue.job.wait.duration": BUCKETS_QUEUE,
  "app.report.render.duration": BUCKETS_QUEUE,
};

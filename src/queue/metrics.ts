/**
 * Métricas da fila: enfileirado, espera, duração e término de cada job. Os gauges de jobs por
 * status e em execução moram em `gauges.ts`.
 *
 * O rótulo `tenant` é a do JOB: a que a fila com `perTenant` gravou nele, ou a do payload nos
 * formatos dos apps (`findTenantDoPayload`). Não é a do contexto de quem enfileira: o
 * consumidor roda fora dele, e o enfileirado e o terminado precisam do mesmo rótulo para casar.
 */

import { hasTenant } from "../handlers/context";
import { METRICA, toOutcome } from "../observability/catalog";
import { incrementMetric, recordMetric, type MetricAttributes } from "../observability/metrics";
import type { QueueJob } from "./adapter";
import { findTenantDoPayload } from "./perTenant";

/** Lê o tenant do payload: a `key` do `perTenant`, quando a fila tem uma. */
export type TenantDoPayload = (payload: unknown) => unknown;

const buildTenant = (
  job: QueueJob,
  tenantOf: TenantDoPayload = findTenantDoPayload,
): MetricAttributes => {
  const tenant = job.tenant || tenantOf(job.payload);
  return hasTenant(tenant) ? { tenant: String(tenant) } : {};
};

const buildAtributos = (
  queue: string,
  job: QueueJob,
  tenantOf?: TenantDoPayload,
): MetricAttributes => ({ queue, ...buildTenant(job, tenantOf) });

export function recordJobEnfileirado(
  queue: string,
  job: QueueJob,
  tenantOf?: TenantDoPayload,
): void {
  incrementMetric({
    ...METRICA.QUEUE_ENQUEUED,
    attributes: buildAtributos(queue, job, tenantOf),
  });
}

/** A espera do job: do enfileiramento (`createdAt`) ao início da execução. */
export function recordJobIniciado(queue: string, job: QueueJob, tenantOf?: TenantDoPayload): void {
  recordMetric({
    ...METRICA.QUEUE_WAIT,
    value: Math.max(0, Date.now() - job.createdAt) / 1000,
    attributes: buildAtributos(queue, job, tenantOf),
  });
}

export function recordJobTerminado(
  queue: string,
  job: QueueJob,
  inicio: number,
  ok: boolean,
  tenantOf?: TenantDoPayload,
): void {
  const attributes = { ...buildAtributos(queue, job, tenantOf), outcome: toOutcome(ok) };
  recordMetric({
    ...METRICA.QUEUE_DURATION,
    value: (performance.now() - inicio) / 1000,
    attributes,
  });
  incrementMetric({ ...METRICA.QUEUE_FINISHED, attributes });
}

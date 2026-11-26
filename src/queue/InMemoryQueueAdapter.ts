/**
 * InMemoryQueueAdapter — adapter de fila em memória (Map).
 *
 * Útil para testes e default quando não há necessidade de persistência.
 * Implementa a interface comum {@link QueueAdapter}.
 */

import {
  emptyQueueStatusCounts,
  type QueueAdapter,
  type QueueTenantLimit,
  type QueueJob,
  type QueuePerTenantQuery,
  type QueueStatusCounts,
} from "./adapter";
import { countPerTenant, selectPerTenant } from "./perTenant";

const ATIVOS = new Set<QueueJob["status"]>(["pending", "processing"]);

export class InMemoryQueueAdapter<T = any> implements QueueAdapter<T> {
  private readonly store = new Map<string, QueueJob<T>>();

  findMany(filter?: Partial<QueueJob<T>>): Array<QueueJob<T>> {
    const all = Array.from(this.store.values()).sort((a, b) => a.createdAt - b.createdAt);
    if (!filter || Object.keys(filter).length === 0) return all;
    return all.filter((job) =>
      Object.entries(filter).every(([key, value]) => (job as any)[key] === value),
    );
  }

  findUnique(id: string): QueueJob<T> | null {
    return this.store.get(id) ?? null;
  }

  create(job: QueueJob<T>): QueueJob<T> {
    this.store.set(job.id, { ...job });
    return { ...job };
  }

  update(id: string, patch: Partial<QueueJob<T>>): QueueJob<T> | null {
    const current = this.store.get(id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    this.store.set(id, updated);
    return { ...updated };
  }

  claim(id: string, lockedAt: number, limite?: QueueTenantLimit): boolean {
    const current = this.store.get(id);
    if (current?.status !== "pending") return false;
    if (this.isTenantCheio(limite)) return false;
    const tenant = limite ? { tenant: limite.tenant } : {};
    this.store.set(id, { ...current, ...tenant, status: "processing", lockedAt });
    return true;
  }

  findPendingPerTenant(query: QueuePerTenantQuery): Array<QueueJob<T>> {
    this.saveTenants(query.tenantOf);
    const emProcessamento = countPerTenant(this.findMany({ status: "processing" }));
    return selectPerTenant(this.findMany({ status: "pending" }), emProcessamento, query).map(
      (job) => ({ ...job }),
    ) as Array<QueueJob<T>>;
  }

  /** Grava o tenant do job pendente ou em processamento que ainda não a tem. */
  private saveTenants(tenantOf: QueuePerTenantQuery["tenantOf"]): void {
    for (const job of this.store.values()) {
      if (job.tenant !== undefined || !ATIVOS.has(job.status)) continue;
      this.store.set(job.id, { ...job, tenant: tenantOf(job.payload) });
    }
  }

  private isTenantCheio(limite: QueueTenantLimit | undefined): boolean {
    if (!limite) return false;
    const emProcessamento = this.findMany({ status: "processing", tenant: limite.tenant });
    return emProcessamento.length >= limite.concurrency;
  }

  delete(id: string): void {
    this.store.delete(id);
  }

  countByStatus(): QueueStatusCounts {
    const counts = emptyQueueStatusCounts();
    for (const job of this.store.values()) counts[job.status] += 1;
    return counts;
  }
}

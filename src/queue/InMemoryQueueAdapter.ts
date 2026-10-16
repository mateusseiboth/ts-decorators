/**
 * InMemoryQueueAdapter — adapter de fila em memória (Map).
 *
 * Útil para testes e default quando não há necessidade de persistência.
 * Implementa a interface comum {@link QueueAdapter}.
 */

import {
  emptyQueueStatusCounts,
  type QueueAdapter,
  type QueueJob,
  type QueueStatusCounts,
} from "./adapter";

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

  claim(id: string, lockedAt: number): boolean {
    const current = this.store.get(id);
    if (current?.status !== "pending") return false;
    this.store.set(id, { ...current, status: "processing", lockedAt });
    return true;
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

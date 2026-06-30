/**
 * @Semaphore({ limit }) — limita a concorrência de um método a `limit` execuções
 * simultâneas. As chamadas excedentes aguardam uma vaga.
 *
 * O limite é GLOBAL por método (compartilhado entre todas as instâncias), ideal
 * para limitar recursos caros — ex.: no SIART, no máx. 3 relatórios por vez.
 *
 * Uso:
 *   @Semaphore({ limit: 3 })
 *   async gerarRelatorio(job) { ... }
 */

import {Semaphore as SemaphorePrimitive} from "../concurrency/Semaphore";
import {makeMethodDecorator} from "./_method";

export interface SemaphoreOptions {
  /** Máximo de execuções concorrentes. Default: 1. */
  limit?: number;
}

// Store global: "Classe.metodo" → Semaphore
const _semaphores = new Map<string, SemaphorePrimitive>();

function getSemaphore(scope: string, limit: number): SemaphorePrimitive {
  let sem = _semaphores.get(scope);
  if (!sem) {
    sem = new SemaphorePrimitive(limit);
    _semaphores.set(scope, sem);
  }
  return sem;
}

/** Limpa os semáforos registrados (útil para testes). */
export function clearSemaphores(): void {
  _semaphores.clear();
}

export function Semaphore(options?: SemaphoreOptions) {
  const limit = Math.max(1, options?.limit ?? 1);
  return makeMethodDecorator("Semaphore", (original, methodName) => {
    return async function (this: any, ...args: any[]) {
      const scope = `${this?.constructor?.name ?? "fn"}.${methodName}`;
      return getSemaphore(scope, limit).runExclusive(() => original.apply(this, args));
    };
  });
}

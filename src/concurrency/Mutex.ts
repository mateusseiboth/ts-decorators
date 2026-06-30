/**
 * Mutex — exclusão mútua (uma execução por vez) baseada em encadeamento de promises.
 *
 * Usado pelo decorator @Mutex e disponível como primitiva isolada.
 *
 * Exemplo:
 * ```ts
 * const mutex = new Mutex();
 * const release = await mutex.acquire();
 * try { ... } finally { release(); }
 *
 * // ou
 * await mutex.runExclusive(async () => { ... });
 * ```
 */

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Adquire o lock; retorna a função de liberação. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = this.tail.then(() => next);
    return previous.then(() => release);
  }

  /** Executa `fn` em exclusão mútua, liberando o lock ao final. */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

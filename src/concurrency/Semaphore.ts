/**
 * Semaphore — limita o número de execuções concorrentes a `limit`.
 *
 * Usado pelo decorator @Semaphore (ex.: limitar a 3 relatórios simultâneos) e
 * disponível como primitiva isolada.
 *
 * Exemplo:
 * ```ts
 * const sem = new Semaphore(3);
 * await sem.runExclusive(async () => { ... }); // no máx. 3 em paralelo
 * ```
 */

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (limit < 1) throw new Error("Semaphore limit deve ser >= 1");
    this.available = limit;
  }

  /** Quantidade de execuções aguardando uma vaga. */
  get pending(): number {
    return this.waiters.length;
  }

  /** Adquire uma vaga; retorna a função de liberação. */
  acquire(): Promise<() => void> {
    const acquired = new Promise<void>((resolve) => {
      if (this.available > 0) {
        this.available--;
        resolve();
        return;
      }
      this.waiters.push(resolve);
    });
    return acquired.then(() => this.makeRelease());
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
        return;
      }
      this.available++;
    };
  }

  /** Executa `fn` respeitando o limite de concorrência. */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

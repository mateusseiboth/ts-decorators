/**
 * QueueAdapter — interface comum de persistência para filas.
 *
 * Qualquer backend (memória, SQLite, Redis, ...) que implemente estes 5 métodos
 * pode ser usado pelos decorators @Queue / @Processor. A ideia é desacoplar a
 * fila do armazenamento: o decorator fala com a interface, não com o banco.
 */

export interface QueueJob<T = any> {
  /** Identificador único do job. */
  id: string;
  /** Carga útil do job (o que o @Processor recebe). */
  payload: T;
  /** Status do job no ciclo de vida da fila. */
  status: "pending" | "processing" | "completed" | "failed";
  /** Epoch (ms) de criação. */
  createdAt: number;
  /** Mensagem de erro, quando `status === "failed"`. */
  error?: string;
}

export interface QueueAdapter<T = any> {
  findMany(filter?: Partial<QueueJob<T>>): Promise<Array<QueueJob<T>>> | Array<QueueJob<T>>;
  findUnique(id: string): Promise<QueueJob<T> | null> | (QueueJob<T> | null);
  create(job: QueueJob<T>): Promise<QueueJob<T>> | QueueJob<T>;
  update(id: string, patch: Partial<QueueJob<T>>): Promise<QueueJob<T> | null> | (QueueJob<T> | null);
  delete(id: string): Promise<void> | void;
}

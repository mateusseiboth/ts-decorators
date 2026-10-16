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
  /**
   * Epoch (ms) da reserva do job, renovado enquanto ele roda. Só existe em `"processing"`: é por
   * ele que a fila reconhece o job de um processo que caiu e o devolve para `"pending"`.
   */
  lockedAt?: number;
}

/** Quantidade de jobs em cada status. */
export type QueueStatusCounts = Record<QueueJob["status"], number>;

export const QUEUE_STATUSES: ReadonlyArray<QueueJob["status"]> = [
  "pending",
  "processing",
  "completed",
  "failed",
];

/** Contagem zerada, com todos os status presentes. */
export const emptyQueueStatusCounts = (): QueueStatusCounts => ({
  pending: 0,
  processing: 0,
  completed: 0,
  failed: 0,
});

export interface QueueAdapter<T = any> {
  findMany(filter?: Partial<QueueJob<T>>): Promise<Array<QueueJob<T>>> | Array<QueueJob<T>>;
  findUnique(id: string): Promise<QueueJob<T> | null> | (QueueJob<T> | null);
  create(job: QueueJob<T>): Promise<QueueJob<T>> | QueueJob<T>;
  update(
    id: string,
    patch: Partial<QueueJob<T>>,
  ): Promise<QueueJob<T> | null> | (QueueJob<T> | null);
  delete(id: string): Promise<void> | void;
  /**
   * Opcional: reserva o job para este processo, de `"pending"` para `"processing"`, numa operação
   * só, gravando `lockedAt`. Devolve `false` quando o job não está mais pendente (outro processo
   * levou). Sem ele, a fila lê e depois grava, e dois processos no mesmo armazenamento podem
   * rodar o mesmo job.
   */
  claim?(id: string, lockedAt: number): Promise<boolean> | boolean;
  /**
   * Opcional: jobs por status sem carregar os payloads (health check). Sem ele, o registro conta
   * pelo `findMany`, que desserializa a fila inteira.
   */
  countByStatus?(): Promise<QueueStatusCounts> | QueueStatusCounts;
  /** Opcional: os `limit` mais recentes (painel de filas), sem ler a fila inteira. */
  findRecent?(
    filter: Partial<QueueJob<T>>,
    limit: number,
  ): Promise<Array<QueueJob<T>>> | Array<QueueJob<T>>;
  /** Opcional: apaga todos os jobs de um status e devolve quantos saíram. */
  deleteByStatus?(status: QueueJob["status"]): Promise<number> | number;
}

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
  /**
   * O tenant do job em texto, gravada pela fila com `perTenant` na primeira vez que olha o job.
   * `""` quando o job não tem tenant. Ausente no job que nenhuma fila com `perTenant` leu.
   */
  tenant?: string;
}

/** Limite do tenant na reserva: o job só é reservado se ela tiver menos de `concurrency` em `processing`. */
export interface QueueTenantLimit {
  /** O tenant do job, em texto. Gravada no job reservado. */
  tenant: string;
  /** Máximo de jobs do tenant em `processing`. */
  concurrency: number;
}

/** Pedido do `findPendingPerTenant`. */
export interface QueuePerTenantQuery {
  /** Quantos jobs devolver, no máximo: as vagas livres da fila. */
  limit: number;
  /** Máximo de jobs do mesmo tenant em `processing`. */
  concurrency: number;
  /** O tenant do payload em texto, `""` sem tenant. Usada no job que ainda não tem `tenant`. */
  tenantOf: (payload: any) => string;
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
   * rodar o mesmo job. Com `limite`, só reserva se o tenant tiver menos de
   * `limite.concurrency` jobs em `processing`, e grava `limite.tenant` no job.
   */
  claim?(id: string, lockedAt: number, limite?: QueueTenantLimit): Promise<boolean> | boolean;
  /**
   * Opcional (`perTenant` do @Processor): os próximos pendentes, intercalando os tenants e
   * pulando o job cuja tenant já tem `concurrency` em `processing`. Grava a `tenant` do job
   * que ainda não a tem. Sem ele, a fila escolhe pelo `findMany`.
   */
  findPendingPerTenant?(
    query: QueuePerTenantQuery,
  ): Promise<Array<QueueJob<T>>> | Array<QueueJob<T>>;
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

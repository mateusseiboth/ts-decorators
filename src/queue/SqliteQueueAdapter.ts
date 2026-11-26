/**
 * SqliteQueueAdapter — adapter de fila persistente sobre bun:sqlite.
 *
 * SQLite em WAL com busy_timeout, para leitura e escrita concorrentes.
 * O payload é serializado como JSON. Implementa a interface comum {@link QueueAdapter}.
 *
 * O job terminado sai da fila depois da retenção (7 dias o concluído, 30 o que falhou, por
 * padrão). Antes ele ficava para sempre, com o payload inteiro: uma fila com payload de 2 MB
 * passou de 400 MB com 200 jobs, todos concluídos.
 *
 * Exemplo:
 * ```ts
 * const adapter = new SqliteQueueAdapter("data/jobs.db", "report_queue");
 * const withoutFalhaApagada = new SqliteQueueAdapter("data/jobs.db", "jobs", { failedRetentionMs: Infinity });
 * ```
 */

import { Database } from "bun:sqlite";

import { logger } from "../functions/logger";
import {
  emptyQueueStatusCounts,
  type QueueAdapter,
  type QueueTenantLimit,
  type QueueJob,
  type QueuePerTenantQuery,
  type QueueStatusCounts,
} from "./adapter";

const DIA_MS = 24 * 60 * 60 * 1000;
const FINISHED = new Set<QueueJob["status"]>(["completed", "failed"]);

export interface SqliteQueueAdapterOptions<T = any> {
  /** Quanto tempo o job concluído fica na fila depois de terminar, em ms. Default: 7 dias. */
  completedRetentionMs?: number;
  /**
   * Quanto tempo o job com falha fica na fila depois de terminar, em ms. Default: 30 dias (dá
   * tempo de investigar e reprocessar). `Infinity` guarda para sempre, nos dois.
   */
  failedRetentionMs?: number;
  /**
   * Intervalo mínimo entre duas limpezas, em ms. A limpeza roda ao abrir e quando um job
   * termina, no máximo uma vez por intervalo. Default: 1 hora.
   */
  cleanupIntervalMs?: number;
  /** Recebe os jobs que a limpeza apagou (para apagar o arquivo que cada um gerou, por exemplo). */
  onPurge?: (jobs: Array<QueueJob<T>>) => void;
}

type FinishedStatus = Extract<QueueJob["status"], "completed" | "failed">;

/** Colunas acrescentadas depois da primeira versão, com o tipo: banco antigo ganha na abertura. */
const COLUNAS_NOVAS: ReadonlyArray<[nome: string, tipo: string]> = [
  ["lockedAt", "INTEGER"],
  ["tenant", "TEXT"],
  ["finishedAt", "INTEGER"],
];

export class SqliteQueueAdapter<T = any> implements QueueAdapter<T> {
  private readonly db: Database;
  private readonly table: string;
  private readonly retentionByStatus: Array<[FinishedStatus, number]>;
  private readonly cleanupIntervalMs: number;
  private readonly onPurge?: (jobs: Array<QueueJob<T>>) => void;
  private lastCleanupAt = 0;

  constructor(dbPath = ":memory:", table = "queue", options: SqliteQueueAdapterOptions<T> = {}) {
    this.table = table;
    this.retentionByStatus = [
      ["completed", options.completedRetentionMs ?? 7 * DIA_MS],
      ["failed", options.failedRetentionMs ?? 30 * DIA_MS],
    ];
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 60 * 1000;
    this.onPurge = options.onPurge;

    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=10000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        error TEXT,
        lockedAt INTEGER,
        tenant TEXT,
        finishedAt INTEGER
      )
    `);
    this.addMissingColumns();
    // O poll procura `status = 'pending'` a cada ciclo: sem índice, lia a tabela inteira,
    // concluídos inclusive.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${this.table}_status ON ${this.table} (status, createdAt)`,
    );
    // Atende a leitura do perTenant: pendentes por tenant em ordem de chegada, a contagem dos
    // em processamento por tenant e o job ainda sem tenant gravado.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS ${this.table}_status_tenant ON ${this.table} (status, tenant, createdAt)`,
    );
    this.purgeFinished();
  }

  /** Banco criado por versão anterior não tem as colunas: `CREATE TABLE IF NOT EXISTS` não as acrescenta. */
  private addMissingColumns(): void {
    const colunas = this.db.query(`PRAGMA table_info(${this.table})`).all() as { name: string }[];
    const existentes = new Set(colunas.map((coluna) => coluna.name));
    for (const [nome, tipo] of COLUNAS_NOVAS.filter(([nome]) => !existentes.has(nome))) {
      this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN ${nome} ${tipo}`);
    }
  }

  /**
   * Apaga os jobs terminados há mais tempo que a retenção e devolve quantos saíram. Pendente e em
   * processamento nunca saem. A linha de versão anterior, sem `finishedAt`, vale pelo `createdAt`.
   */
  purgeFinished(now = Date.now()): number {
    this.lastCleanupAt = now;
    return this.retentionByStatus
      .filter(([, retentionMs]) => Number.isFinite(retentionMs))
      .reduce(
        (total, [status, retentionMs]) => total + this.deleteExpired(status, now - retentionMs),
        0,
      );
  }

  private deleteExpired(status: FinishedStatus, cutoff: number): number {
    const sql = `DELETE FROM ${this.table} WHERE status = ? AND COALESCE(finishedAt, createdAt) < ?`;
    if (!this.onPurge) return this.db.run(sql, [status, cutoff]).changes;
    const rows = this.db.query(`${sql} RETURNING *`).all(status, cutoff) as any[];
    if (!rows.length) return 0;
    try {
      this.onPurge(rows.map((row) => this.parse(row)));
    } catch (err) {
      logger.error(`[Queue:${this.table}] onPurge falhou:`, err);
    }
    return rows.length;
  }

  /**
   * Limpeza disparada pelo job que terminou, no máximo uma vez por intervalo. Nunca lança: o job
   * já terminou, e uma falha da limpeza não pode virar falha dele.
   */
  private purgeWhenDue(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) return;
    try {
      this.purgeFinished(now);
    } catch (err) {
      logger.error(`[Queue:${this.table}] Falha ao limpar os jobs terminados:`, err);
    }
  }

  findMany(filter?: Partial<QueueJob<T>>): Array<QueueJob<T>> {
    const clauses: string[] = [];
    const params: any[] = [];
    for (const [key, value] of Object.entries(filter ?? {})) {
      if (key === "payload") continue; // não filtramos por payload serializado
      clauses.push(`${key} = ?`);
      params.push(value);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM ${this.table} ${where} ORDER BY createdAt ASC`)
      .all(...params) as any[];
    return rows.map((row) => this.parse(row));
  }

  findUnique(id: string): QueueJob<T> | null {
    const row = this.db.query(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as any;
    return row ? this.parse(row) : null;
  }

  create(job: QueueJob<T>): QueueJob<T> {
    this.db.run(
      `INSERT INTO ${this.table} (id, payload, status, createdAt, error, lockedAt, tenant) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        JSON.stringify(job.payload),
        job.status,
        job.createdAt,
        job.error ?? null,
        job.lockedAt ?? null,
        job.tenant ?? null,
      ],
    );
    return { ...job };
  }

  update(id: string, patch: Partial<QueueJob<T>>): QueueJob<T> | null {
    const current = this.findUnique(id);
    if (!current) return null;
    const updated: QueueJob<T> = { ...current, ...patch };
    // `finishedAt`: a hora em que o job terminou, mantida enquanto ele segue terminado; o job que
    // volta para a fila (reprocessar) perde a marca.
    this.db.run(
      `UPDATE ${this.table} SET payload = ?, status = ?, error = ?, lockedAt = ?, tenant = ?,
        finishedAt = CASE WHEN status IN ('completed', 'failed') AND ? IN ('completed', 'failed')
          THEN finishedAt WHEN ? IN ('completed', 'failed') THEN ? END
       WHERE id = ?`,
      [
        JSON.stringify(updated.payload),
        updated.status,
        updated.error ?? null,
        updated.lockedAt ?? null,
        updated.tenant ?? null,
        updated.status,
        updated.status,
        Date.now(),
        id,
      ],
    );
    if (FINISHED.has(updated.status)) this.purgeWhenDue();
    return updated;
  }

  /**
   * O `WHERE status = 'pending'` faz a reserva ser de um processo só: quem chega depois não altera
   * linha nenhuma. Com `limite`, a contagem do tenant está no mesmo `UPDATE`: o SQLite grava um
   * de cada vez, então dois processos não passam juntos do limite.
   */
  claim(id: string, lockedAt: number, limite?: QueueTenantLimit): boolean {
    if (!limite) {
      return (
        this.db.run(
          `UPDATE ${this.table} SET status = 'processing', lockedAt = ? WHERE id = ? AND status = 'pending'`,
          [lockedAt, id],
        ).changes === 1
      );
    }
    const { changes } = this.db.run(
      `UPDATE ${this.table} SET status = 'processing', lockedAt = ?, tenant = ?
        WHERE id = ? AND status = 'pending'
          AND (SELECT COUNT(*) FROM ${this.table} WHERE status = 'processing' AND tenant = ?) < ?`,
      [lockedAt, limite.tenant, id, limite.tenant, limite.concurrency],
    );
    return changes === 1;
  }

  /**
   * A escolha do `perTenant` na consulta: só o `id` dos escolhidos sai da janela, e o `payload`
   * é lido apenas para eles. A fila com milhares de pendentes não é desserializada a cada ciclo.
   */
  findPendingPerTenant(query: QueuePerTenantQuery): Array<QueueJob<T>> {
    this.saveTenants(query.tenantOf);
    const rows = this.db
      .query(
        `WITH em_processamento AS (
           SELECT tenant, COUNT(*) AS total FROM ${this.table}
            WHERE status = 'processing' GROUP BY tenant
         ),
         pendentes AS (
           SELECT rowid AS linha, tenant, createdAt,
                  ROW_NUMBER() OVER (PARTITION BY tenant ORDER BY createdAt, rowid) AS ordem
             FROM ${this.table} WHERE status = 'pending'
         ),
         candidatos AS (
           SELECT p.linha, p.createdAt,
                  CASE WHEN p.tenant = '' THEN 1 ELSE p.ordem + COALESCE(e.total, 0) END AS vez
             FROM pendentes p LEFT JOIN em_processamento e ON e.tenant = p.tenant
         )
         SELECT t.* FROM candidatos c JOIN ${this.table} t ON t.rowid = c.linha
          WHERE c.vez <= ?
          ORDER BY c.vez, c.createdAt, c.linha
          LIMIT ?`,
      )
      .all(query.concurrency, query.limit) as any[];
    return rows.map((row) => this.parse(row));
  }

  /**
   * Grava o tenant do job pendente ou em processamento que ainda não a tem (enfileirado antes
   * de existir consumidor com `perTenant`, ou por versão anterior). Cada job é lido uma vez só.
   */
  private saveTenants(tenantOf: QueuePerTenantQuery["tenantOf"]): void {
    const withoutTenant = this.db
      .query(
        `SELECT id, payload FROM ${this.table} WHERE status IN ('pending', 'processing') AND tenant IS NULL`,
      )
      .all() as Array<{ id: string; payload: string }>;
    if (withoutTenant.length === 0) return;
    const gravar = this.db.prepare(`UPDATE ${this.table} SET tenant = ? WHERE id = ?`);
    this.db.transaction(() => {
      for (const job of withoutTenant) gravar.run(tenantOf(JSON.parse(job.payload)), job.id);
    })();
  }

  delete(id: string): void {
    this.db.run(`DELETE FROM ${this.table} WHERE id = ?`, [id]);
  }

  findRecent(filter: Partial<QueueJob<T>>, limit: number): Array<QueueJob<T>> {
    const status = filter.status;
    const rows = (
      status
        ? this.db
            .query(`SELECT * FROM ${this.table} WHERE status = ? ORDER BY createdAt DESC LIMIT ?`)
            .all(status, limit)
        : this.db.query(`SELECT * FROM ${this.table} ORDER BY createdAt DESC LIMIT ?`).all(limit)
    ) as any[];
    return rows.map((row) => this.parse(row));
  }

  deleteByStatus(status: QueueJob["status"]): number {
    return this.db.run(`DELETE FROM ${this.table} WHERE status = ?`, [status]).changes;
  }

  /** `GROUP BY status`: conta sem ler nem desserializar os payloads. */
  countByStatus(): QueueStatusCounts {
    const rows = this.db
      .query(`SELECT status, COUNT(*) AS total FROM ${this.table} GROUP BY status`)
      .all() as Array<{ status: QueueJob["status"]; total: number }>;
    const counts = emptyQueueStatusCounts();
    for (const row of rows) counts[row.status] = Number(row.total);
    return counts;
  }

  close(): void {
    this.db.close();
  }

  private parse(row: any): QueueJob<T> {
    return {
      id: row.id,
      payload: JSON.parse(row.payload),
      status: row.status,
      createdAt: row.createdAt,
      error: row.error ?? undefined,
      lockedAt: row.lockedAt ?? undefined,
      tenant: row.tenant ?? undefined,
    };
  }
}

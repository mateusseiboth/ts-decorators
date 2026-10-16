/**
 * SqliteQueueAdapter — adapter de fila persistente sobre bun:sqlite.
 *
 * SQLite em WAL com busy_timeout, para leitura e escrita concorrentes.
 * O payload é serializado como JSON. Implementa a interface comum {@link QueueAdapter}.
 *
 * Exemplo:
 * ```ts
 * const adapter = new SqliteQueueAdapter("data/jobs.db", "report_queue");
 * ```
 */

import { Database } from "bun:sqlite";

import {
  emptyQueueStatusCounts,
  type QueueAdapter,
  type QueueJob,
  type QueueStatusCounts,
} from "./adapter";

export class SqliteQueueAdapter<T = any> implements QueueAdapter<T> {
  private readonly db: Database;
  private readonly table: string;

  constructor(dbPath = ":memory:", table = "queue") {
    this.table = table;
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
        lockedAt INTEGER
      )
    `);
    this.addLockedAtColumn();
  }

  /** Banco criado por versão anterior não tem a coluna: `CREATE TABLE IF NOT EXISTS` não a acrescenta. */
  private addLockedAtColumn(): void {
    const colunas = this.db.query(`PRAGMA table_info(${this.table})`).all() as { name: string }[];
    if (colunas.some((coluna) => coluna.name === "lockedAt")) return;
    this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN lockedAt INTEGER`);
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
      `INSERT INTO ${this.table} (id, payload, status, createdAt, error, lockedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        JSON.stringify(job.payload),
        job.status,
        job.createdAt,
        job.error ?? null,
        job.lockedAt ?? null,
      ],
    );
    return { ...job };
  }

  update(id: string, patch: Partial<QueueJob<T>>): QueueJob<T> | null {
    const current = this.findUnique(id);
    if (!current) return null;
    const updated: QueueJob<T> = { ...current, ...patch };
    this.db.run(
      `UPDATE ${this.table} SET payload = ?, status = ?, error = ?, lockedAt = ? WHERE id = ?`,
      [
        JSON.stringify(updated.payload),
        updated.status,
        updated.error ?? null,
        updated.lockedAt ?? null,
        id,
      ],
    );
    return updated;
  }

  /** O `WHERE status = 'pending'` faz a reserva ser de um processo só: quem chega depois não altera linha nenhuma. */
  claim(id: string, lockedAt: number): boolean {
    const { changes } = this.db.run(
      `UPDATE ${this.table} SET status = 'processing', lockedAt = ? WHERE id = ? AND status = 'pending'`,
      [lockedAt, id],
    );
    return changes === 1;
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
    };
  }
}

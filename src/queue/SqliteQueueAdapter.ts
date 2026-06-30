/**
 * SqliteQueueAdapter — adapter de fila persistente sobre bun:sqlite.
 *
 * Segue o mesmo padrão (WAL + busy_timeout) usado no ReportQueueManager do SIART.
 * O payload é serializado como JSON. Implementa a interface comum {@link QueueAdapter}.
 *
 * Exemplo:
 * ```ts
 * const adapter = new SqliteQueueAdapter("data/jobs.db", "report_queue");
 * ```
 */

import {Database} from "bun:sqlite";
import type {QueueAdapter, QueueJob} from "./adapter";

export class SqliteQueueAdapter<T = any> implements QueueAdapter<T> {
  private readonly db: Database;
  private readonly table: string;

  constructor(dbPath = ":memory:", table = "queue") {
    this.table = table;
    this.db = new Database(dbPath, {create: true});
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=10000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        error TEXT
      )
    `);
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
      `INSERT INTO ${this.table} (id, payload, status, createdAt, error) VALUES (?, ?, ?, ?, ?)`,
      [job.id, JSON.stringify(job.payload), job.status, job.createdAt, job.error ?? null],
    );
    return {...job};
  }

  update(id: string, patch: Partial<QueueJob<T>>): QueueJob<T> | null {
    const current = this.findUnique(id);
    if (!current) return null;
    const updated: QueueJob<T> = {...current, ...patch};
    this.db.run(`UPDATE ${this.table} SET payload = ?, status = ?, error = ? WHERE id = ?`, [
      JSON.stringify(updated.payload),
      updated.status,
      updated.error ?? null,
      id,
    ]);
    return updated;
  }

  delete(id: string): void {
    this.db.run(`DELETE FROM ${this.table} WHERE id = ?`, [id]);
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
    };
  }
}

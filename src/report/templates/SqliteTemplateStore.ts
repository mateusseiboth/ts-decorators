import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

import type { ReportTemplate, ReportTemplateStore } from "../types";

/**
 * TemplateStore default — tabela `report_templates` no MESMO SQLite da engine
 * (plugar a engine nunca exige migration no banco nativo do app). O app pode
 * substituir via `templateStore` na config.
 */
export class SqliteTemplateStore implements ReportTemplateStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=10000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS report_templates (
        id TEXT PRIMARY KEY,
        reportId TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_report_templates_reportId ON report_templates (reportId)",
    );
  }

  save(reportId: string, template: { name: string; content: string }): ReportTemplate {
    const row: ReportTemplate = {
      id: randomUUID(),
      reportId,
      name: template.name,
      content: template.content,
      active: false,
      createdAt: Date.now(),
    };
    this.db.run(
      "INSERT INTO report_templates (id, reportId, name, content, active, createdAt) VALUES (?, ?, ?, ?, 0, ?)",
      [row.id, row.reportId, row.name, row.content, row.createdAt],
    );
    return row;
  }

  list(reportId: string): ReportTemplate[] {
    const rows = this.db
      .query("SELECT * FROM report_templates WHERE reportId = ? ORDER BY createdAt DESC")
      .all(reportId) as any[];
    return rows.map((row) => this.parse(row));
  }

  get(id: string): ReportTemplate | null {
    const row = this.db.query("SELECT * FROM report_templates WHERE id = ?").get(id) as any;
    return row ? this.parse(row) : null;
  }

  setActive(reportId: string, templateId: string | null): void {
    this.db.run("UPDATE report_templates SET active = 0 WHERE reportId = ?", [reportId]);
    if (!templateId) return;
    this.db.run("UPDATE report_templates SET active = 1 WHERE id = ? AND reportId = ?", [
      templateId,
      reportId,
    ]);
  }

  getActive(reportId: string): ReportTemplate | null {
    const row = this.db
      .query("SELECT * FROM report_templates WHERE reportId = ? AND active = 1 LIMIT 1")
      .get(reportId) as any;
    return row ? this.parse(row) : null;
  }

  close(): void {
    this.db.close();
  }

  private parse(row: any): ReportTemplate {
    return {
      id: row.id,
      reportId: row.reportId,
      name: row.name,
      content: row.content,
      active: row.active === 1,
      createdAt: row.createdAt,
    };
  }
}

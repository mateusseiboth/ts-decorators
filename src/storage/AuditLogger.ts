import {Database} from "bun:sqlite";
import {existsSync, mkdirSync} from "fs";
import path from "path";

const SENSITIVE_KEYS = new Set(["senha", "password", "token", "secret", "access_token", "refresh_token"]);

function maskSensitive(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitive);
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
      k,
      SENSITIVE_KEYS.has(k.toLowerCase()) ? "***" : maskSensitive(v),
    ]),
  );
}

export interface AuditEntry {
  method: string;
  url: string;
  action?: string;
  statusCode?: number;
  durationMs?: number;
  requestBody?: unknown;
  requestParams?: unknown;
  requestQuery?: unknown;
  responseBody?: unknown;
  entity?: number;
  exercicio?: number;
  userId?: string;
  username?: string;
  requestId?: string;
}

export class AuditLogger {
  private static instance: AuditLogger;
  private db: Database;

  private constructor() {
    const rootPath = process.cwd();
    const logsDir = path.join(rootPath, "logs");

    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, {recursive: true});
    }

    this.db = new Database(path.join(logsDir, "audit.db"), {create: true});
    this.init();
  }

  static getInstance(): AuditLogger {
    if (!AuditLogger.instance) {
      AuditLogger.instance = new AuditLogger();
    }
    return AuditLogger.instance;
  }

  private init(): void {
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=10000");
    this.db.exec("PRAGMA synchronous=NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id          TEXT    PRIMARY KEY,
        timestamp   INTEGER NOT NULL,
        method      TEXT    NOT NULL,
        url         TEXT    NOT NULL,
        action      TEXT,
        status_code INTEGER,
        duration_ms INTEGER,
        request_body   TEXT,
        request_params TEXT,
        request_query  TEXT,
        response_body  TEXT,
        entity      INTEGER,
        exercicio   INTEGER,
        user_id     TEXT,
        username    TEXT,
        request_id  TEXT
      )
    `);

    // Migração não-destrutiva: adiciona coluna se ainda não existir (banco legado)
    try {
      this.db.exec("ALTER TABLE audit_logs ADD COLUMN response_body TEXT");
    } catch {
      // coluna já existe, ignorar
    }

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs (timestamp DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs (user_id, entity)`);
  }

  log(entry: AuditEntry): void {
    try {
      this.db.run(
        `INSERT INTO audit_logs (
          id, timestamp, method, url, action, status_code, duration_ms,
          request_body, request_params, request_query, response_body,
          entity, exercicio, user_id, username, request_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          Date.now(),
          entry.method,
          entry.url,
          entry.action ?? null,
          entry.statusCode ?? null,
          entry.durationMs ?? null,
          entry.requestBody != null ? JSON.stringify(maskSensitive(entry.requestBody)) : null,
          entry.requestParams != null ? JSON.stringify(entry.requestParams) : null,
          entry.requestQuery != null ? JSON.stringify(entry.requestQuery) : null,
          entry.responseBody != null ? JSON.stringify(maskSensitive(entry.responseBody)) : null,
          entry.entity ?? null,
          entry.exercicio ?? null,
          entry.userId ?? null,
          entry.username ?? null,
          entry.requestId ?? null,
        ],
      );
    } catch (err) {
      console.error("[AuditLogger] Failed to write log entry:", err);
    }
  }

  close(): void {
    this.db.close();
  }
}

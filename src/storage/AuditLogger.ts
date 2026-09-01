import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import path from "path";

import { logger } from "../functions/logger";

const SENSITIVE_KEYS = new Set([
  "senha",
  "password",
  "token",
  "secret",
  "access_token",
  "refresh_token",
  "inviteurl",
]);

/**
 * Máscara e BigInt resolvidos DENTRO do `JSON.stringify`, numa passada só.
 *
 * A versão anterior reconstruía a árvore inteira duas vezes antes de serializar
 * (uma para mascarar, outra para converter BigInt) e só então percorria tudo de
 * novo no `stringify`. Com corpo de 20 KB — o tamanho médio real de uma listagem —
 * eram três travessias e duas árvores descartadas por requisição.
 */
function replacer(mask: boolean) {
  return function (this: unknown, key: string, value: unknown): unknown {
    if (mask && SENSITIVE_KEYS.has(key.toLowerCase())) return "***";
    // `JSON.stringify` estoura em BigInt, e `id`/`sequencial` do Prisma chegam assim.
    if (typeof value === "bigint") return value.toString();
    return value;
  };
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

export interface AuditLoggerOptions {
  /** Caminho do arquivo SQLite. Default: `<cwd>/logs/audit.db`. */
  path?: string;
  /** Janela de agrupamento das escritas, em ms. Default: 250. */
  flushIntervalMs?: number;
  /** Quantas entradas forçam um flush imediato. Default: 200. */
  maxBatch?: number;
  /**
   * Teto de bytes por campo TEXT. Acima disso o valor é substituído por um resumo.
   * Default: 200_000 — o SQLite recusa TEXT grande demais (`SQLITE_TOOBIG`), e uma
   * listagem de 15 mil linhas passa fácil desse tamanho.
   */
  maxTextBytes?: number;
}

const INSERT_SQL = `INSERT INTO audit_logs (
  id, timestamp, method, url, action, status_code, duration_ms,
  request_body, request_params, request_query, response_body,
  entity, exercicio, user_id, username, request_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Uma linha já pronta para o INSERT — nada mais a serializar no flush. */
type AuditRow = (string | number | null)[];

/**
 * Log de auditoria em SQLite, com escrita AGRUPADA.
 *
 * Antes cada `log()` era um `INSERT` próprio — SQL reparseado e uma transação
 * por requisição, tudo no caminho da resposta. Agora a linha é montada na hora
 * (o body pode ser mutado depois) e a ida ao disco acontece em lote, fora do
 * request, com statement preparado uma única vez.
 */
export class AuditLogger {
  private static instance: AuditLogger | undefined;
  private static options: AuditLoggerOptions = {};

  private readonly db: Database;
  private readonly insert: ReturnType<Database["query"]>;
  private readonly flushIntervalMs: number;
  private readonly maxBatch: number;
  private readonly maxTextBytes: number;
  private readonly flushBatch: (rows: AuditRow[]) => void;

  private buffer: AuditRow[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly flushOnExit = () => this.flush();

  private constructor(options: AuditLoggerOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.maxBatch = options.maxBatch ?? 200;
    this.maxTextBytes = options.maxTextBytes ?? 200_000;

    const filePath = options.path ?? path.join(process.cwd(), "logs", "audit.db");
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(filePath, { create: true });
    this.init();
    this.insert = this.db.query(INSERT_SQL);
    this.flushBatch = this.db.transaction((rows: AuditRow[]) => {
      for (const row of rows) this.insert.run(...(row as any));
    });

    // O buffer não pode morrer com o processo levando auditoria junto.
    process.on("beforeExit", this.flushOnExit);
    process.on("exit", this.flushOnExit);
  }

  /**
   * Ajusta o destino e o agrupamento. Precisa vir ANTES do primeiro
   * `getInstance()` — depois disso, use `reset()`.
   */
  static configure(options: AuditLoggerOptions): void {
    AuditLogger.options = options;
  }

  static getInstance(): AuditLogger {
    if (!AuditLogger.instance) {
      AuditLogger.instance = new AuditLogger(AuditLogger.options);
    }
    return AuditLogger.instance;
  }

  /** Descarrega, fecha e esquece a instância (testes e troca de configuração). */
  static reset(): void {
    AuditLogger.instance?.close();
    AuditLogger.instance = undefined;
    AuditLogger.options = {};
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

  /** Serializa sem NUNCA lançar: auditoria é best-effort e não derruba a request. */
  private serialize(value: unknown, mask: boolean): string | null {
    if (value == null) return null;

    let json: string | null;
    try {
      json = JSON.stringify(value, replacer(mask)) ?? null;
    } catch (err) {
      // Referência circular, getter que lança, BigInt em campo não mascarado…
      return JSON.stringify({
        _unserializable: true,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    if (json == null) return null;

    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes <= this.maxTextBytes) return json;
    return JSON.stringify({ _truncated: true, bytes, preview: json.slice(0, 2_000) });
  }

  /** Enfileira a entrada. A ida ao disco acontece no flush (lote). */
  log(entry: AuditEntry): void {
    if (this.closed) return;
    try {
      this.buffer.push([
        // UUIDv7 é ordenável no tempo: as inserções caem no fim do índice da PK,
        // em vez de espalhadas pela árvore como o v4.
        Bun.randomUUIDv7(),
        Date.now(),
        entry.method,
        entry.url,
        entry.action ?? null,
        entry.statusCode ?? null,
        entry.durationMs ?? null,
        this.serialize(entry.requestBody, true),
        this.serialize(entry.requestParams, false),
        this.serialize(entry.requestQuery, false),
        this.serialize(entry.responseBody, true),
        entry.entity ?? null,
        entry.exercicio ?? null,
        entry.userId ?? null,
        entry.username ?? null,
        entry.requestId ?? null,
      ]);
    } catch (err) {
      logger.error("[AuditLogger] Failed to queue log entry:", err);
      return;
    }

    if (this.buffer.length >= this.maxBatch) return this.flush();
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushIntervalMs);
    // Auditoria pendente não pode segurar o processo de pé.
    this.timer.unref?.();
  }

  /** Grava agora tudo que está no buffer, numa única transação. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer.length) return;

    const rows = this.buffer;
    this.buffer = [];
    try {
      this.flushBatch(rows);
    } catch (err) {
      logger.error("[AuditLogger] Failed to write log entries:", err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    process.off("beforeExit", this.flushOnExit);
    process.off("exit", this.flushOnExit);
    this.db.close();
  }
}

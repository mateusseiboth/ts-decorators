import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import path from "path";

import { isEncryptedFieldName } from "../fields/rowFields";
import { logger } from "../functions/logger";
import { METRICA } from "../observability/catalog";
import { incrementMetric } from "../observability/metrics";

/** Cada entrada que não chegou ao disco conta em `app.audit.write_failure`. */
const countFalhas = (entradas: number): void =>
  incrementMetric({ ...METRICA.AUDIT_WRITE_FAILURE, value: entradas });

/** Chaves sempre mascaradas, sem diferenciar maiúsculas. `sensitiveKeys` soma outras a estas. */
const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  "senha",
  "password",
  "token",
  "secret",
  "access_token",
  "refresh_token",
  "inviteurl",
  "authorization",
  "cookie",
];

type KeyPredicate = (key: string) => boolean;

/** `requestParams` e `requestQuery` são gravados como chegam. */
const NO_MASK: KeyPredicate = () => false;

/** Nome sensível (padrão ou extra), ou campo `@Field({ encrypted: true })` de algum model. */
function buildSensitiveKeyPredicate(extra: readonly string[] = []): KeyPredicate {
  const keys = new Set([...DEFAULT_SENSITIVE_KEYS, ...extra].map((key) => key.toLowerCase()));
  return (key) => keys.has(key.toLowerCase()) || isEncryptedFieldName(key);
}

/**
 * Máscara e BigInt resolvidos DENTRO do `JSON.stringify`, numa passada só.
 *
 * A versão anterior reconstruía a árvore inteira duas vezes antes de serializar
 * (uma para mascarar, outra para converter BigInt) e só então percorria tudo de
 * novo no `stringify`. Com corpo de 20 KB — o tamanho médio real de uma listagem —
 * eram três travessias e duas árvores descartadas por requisição.
 */
function replacer(isSensitiveKey: KeyPredicate) {
  return function (this: unknown, key: string, value: unknown): unknown {
    if (isSensitiveKey(key)) return "***";
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

/** Período de cada arquivo: `"none"` é o arquivo único de antes. */
export type AuditLogRotation = "monthly" | "daily" | "none";

export interface AuditLoggerOptions {
  /**
   * Caminho do arquivo SQLite. Default: `<cwd>/logs/audit.db`. Com rotação, o período entra antes
   * da extensão: `logs/audit-2026-11.db`.
   */
  path?: string;
  /** Um arquivo por mês (`"monthly"`, o padrão), por dia (`"daily"`) ou um só (`"none"`). */
  rotate?: AuditLogRotation;
  /**
   * Quantos períodos manter, contando o atual. Os arquivos mais antigos são apagados ao abrir e a
   * cada troca de período. Default: 12 no mensal (um ano), 90 no diário. `Infinity` nunca apaga.
   */
  retention?: number;
  /**
   * Verbos HTTP cujo corpo de RESPOSTA não é gravado (ex.: `["GET"]`: a listagem devolvida pesa e
   * não diz o que mudou). Default: nenhum, grava tudo.
   */
  skipResponseBody?: string[];
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
  /**
   * Chaves a mascarar ALÉM das padrão (senha, password, token, secret, access_token,
   * refresh_token, inviteUrl, authorization, cookie), sem diferenciar maiúsculas.
   * Vale para `requestBody` e `responseBody`, em qualquer nível. Default: nenhuma.
   */
  sensitiveKeys?: readonly string[];
}

const INSERT_SQL = `INSERT INTO audit_logs (
  id, timestamp, method, url, action, status_code, duration_ms,
  request_body, request_params, request_query, response_body,
  entity, exercicio, user_id, username, request_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Uma linha já pronta para o INSERT — nada mais a serializar no flush. */
type AuditRow = (string | number | null)[];

/** Posição do `timestamp` na linha: é por ele que a linha escolhe o arquivo do período. */
const TIMESTAMP_INDEX = 1;

const pad = (value: number): string => String(value).padStart(2, "0");
const monthOf = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
const dayOf = (date: Date): string => `${monthOf(date)}-${pad(date.getDate())}`;

interface RotationStrategy {
  /** Nome do período no arquivo. Vazio: arquivo único, sem período. */
  periodOf: (date: Date) => string;
  /** O período mais antigo que a retenção mantém, contando o atual. */
  firstKept: (now: Date, retention: number) => string;
  /** Como o período aparece no nome do arquivo. */
  pattern: string;
  defaultRetention: number;
}

/**
 * O período sai da hora LOCAL do processo (no container, quase sempre UTC). Os nomes ordenam como
 * texto: `2026-09` < `2026-10`, e é assim que a retenção compara.
 */
const ROTATIONS: Record<AuditLogRotation, RotationStrategy> = {
  monthly: {
    periodOf: monthOf,
    firstKept: (now, retention) =>
      monthOf(new Date(now.getFullYear(), now.getMonth() - (retention - 1), 1)),
    pattern: String.raw`\d{4}-\d{2}`,
    defaultRetention: 12,
  },
  daily: {
    periodOf: dayOf,
    firstKept: (now, retention) =>
      dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (retention - 1))),
    pattern: String.raw`\d{4}-\d{2}-\d{2}`,
    defaultRetention: 90,
  },
  none: {
    periodOf: () => "",
    firstKept: () => "",
    pattern: "(?!)",
    defaultRetention: Number.POSITIVE_INFINITY,
  },
};

/** O arquivo SQLite e os que o modo WAL cria ao lado dele. */
const SQLITE_COMPANIONS = ["", "-wal", "-shm", "-journal"];

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** O arquivo aberto: o do período corrente. */
interface AuditFile {
  period: string;
  filePath: string;
  db: Database;
  flushBatch: (rows: AuditRow[]) => void;
}

function groupByPeriod(
  rows: AuditRow[],
  periodOf: (date: Date) => string,
): Map<string, AuditRow[]> {
  const grupos = new Map<string, AuditRow[]>();
  for (const row of rows) {
    const period = periodOf(new Date(row[TIMESTAMP_INDEX] as number));
    grupos.set(period, [...(grupos.get(period) ?? []), row]);
  }
  return grupos;
}

function removeDbFile(filePath: string): void {
  for (const suffix of SQLITE_COMPANIONS) rmSync(`${filePath}${suffix}`, { force: true });
}

/** Última escrita do arquivo, olhando também o WAL (que recebe a escrita antes do arquivo). */
function lastWriteOf(filePath: string): Date {
  const times = [filePath, `${filePath}-wal`]
    .filter((file) => existsSync(file))
    .map((file) => statSync(file).mtimeMs);
  return new Date(Math.max(...times));
}

/**
 * Log de auditoria em SQLite, com escrita AGRUPADA e um arquivo por período.
 *
 * Antes cada `log()` era um `INSERT` próprio — SQL reparseado e uma transação
 * por requisição, tudo no caminho da resposta. Agora a linha é montada na hora
 * (o body pode ser mutado depois) e a ida ao disco acontece em lote, fora do
 * request, com statement preparado uma única vez.
 *
 * O arquivo único crescia sem limite (corpo de requisição e resposta em toda chamada). Agora cada
 * mês (ou dia) tem o seu, e os mais antigos que a retenção são apagados. Cada linha vai para o
 * arquivo do momento em que foi REGISTRADA: o lote que atravessa a meia-noite da virada se divide
 * entre os dois arquivos, sem perder nem trocar de período nenhuma entrada.
 */
export class AuditLogger {
  private static instance: AuditLogger | undefined;
  private static options: AuditLoggerOptions = {};

  private readonly basePath: string;
  private readonly rotation: RotationStrategy;
  private readonly retention: number;
  private readonly skipResponseBody: ReadonlySet<string>;
  private readonly flushIntervalMs: number;
  private readonly maxBatch: number;
  private readonly maxTextBytes: number;
  private readonly isSensitiveKey: KeyPredicate;

  private current: AuditFile;
  private buffer: AuditRow[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly flushOnExit = () => this.flush();

  private constructor(options: AuditLoggerOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.maxBatch = options.maxBatch ?? 200;
    this.maxTextBytes = options.maxTextBytes ?? 200_000;
    this.isSensitiveKey = buildSensitiveKeyPredicate(options.sensitiveKeys);
    this.rotation = ROTATIONS[options.rotate ?? "monthly"];
    this.retention = Math.max(1, options.retention ?? this.rotation.defaultRetention);
    this.skipResponseBody = new Set(
      (options.skipResponseBody ?? []).map((method) => method.toUpperCase()),
    );

    this.basePath = options.path ?? path.join(process.cwd(), "logs", "audit.db");
    const dir = path.dirname(this.basePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.current = this.openFile(this.rotation.periodOf(new Date()));
    this.applyRetention();

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

  private filePathOf(period: string): string {
    if (!period) return this.basePath;
    const { dir, name, ext } = path.parse(this.basePath);
    return path.join(dir, `${name}-${period}${ext}`);
  }

  private openFile(period: string): AuditFile {
    const filePath = this.filePathOf(period);
    const db = new Database(filePath, { create: true });
    this.init(db);
    const insert = db.query(INSERT_SQL);
    const flushBatch = db.transaction((rows: AuditRow[]) => {
      for (const row of rows) insert.run(...(row as any));
    });
    return { period, filePath, db, flushBatch };
  }

  /** O arquivo do período. O de outro período fecha o aberto e passa a ser o corrente. */
  private fileFor(period: string): AuditFile {
    if (this.current.period === period) return this.current;
    this.current.db.close();
    this.current = this.openFile(period);
    this.applyRetention();
    return this.current;
  }

  /** Os arquivos com período no nome, do mais antigo para o mais novo. */
  private rotatedFiles(): string[] {
    const { dir, name, ext } = path.parse(this.basePath);
    const nome = new RegExp(`^${escapeRegex(name)}-(${this.rotation.pattern})${escapeRegex(ext)}$`);
    return readdirSync(dir)
      .filter((file) => nome.test(file))
      .sort()
      .map((file) => path.join(dir, file));
  }

  /** O arquivo único de antes da rotação, quando existe: com rotação ligada, não recebe mais nada. */
  private legacyFiles(): string[] {
    if (!this.current.period) return [this.basePath];
    return existsSync(this.basePath) ? [this.basePath] : [];
  }

  /**
   * Todos os arquivos do log, do mais antigo para o mais novo: o `audit.db` de antes da rotação
   * (quando existe) e os de cada período. É por aqui que quem lê a auditoria encontra os arquivos.
   */
  listFiles(): string[] {
    return [...this.legacyFiles(), ...this.rotatedFiles()];
  }

  private periodOfFile(filePath: string): string {
    if (filePath === this.basePath) return this.rotation.periodOf(lastWriteOf(filePath));
    return path.parse(filePath).name.slice(path.parse(this.basePath).name.length + 1);
  }

  /** Apaga o que passou da retenção. O arquivo de antes da rotação vale pela última escrita dele. */
  private applyRetention(): void {
    if (!Number.isFinite(this.retention)) return;
    try {
      const firstKept = this.rotation.firstKept(new Date(), this.retention);
      const expirados = this.listFiles().filter(
        (file) => file !== this.current.filePath && this.periodOfFile(file) < firstKept,
      );
      for (const file of expirados) removeDbFile(file);
    } catch (err) {
      logger.error("[AuditLogger] Failed to apply retention:", err);
    }
  }

  private init(db: Database): void {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=10000");
    db.exec("PRAGMA synchronous=NORMAL");

    db.exec(`
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
      db.exec("ALTER TABLE audit_logs ADD COLUMN response_body TEXT");
    } catch {
      // coluna já existe, ignorar
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs (timestamp DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs (user_id, entity)`);
  }

  /** Serializa sem NUNCA lançar: auditoria é best-effort e não derruba a request. */
  private serialize(value: unknown, isSensitiveKey: KeyPredicate): string | null {
    if (value == null) return null;

    let json: string | null;
    try {
      json = JSON.stringify(value, replacer(isSensitiveKey)) ?? null;
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

  /** O corpo da resposta, a menos que o verbo esteja em `skipResponseBody`. */
  private responseBodyOf(entry: AuditEntry): unknown {
    if (this.skipResponseBody.has(entry.method.toUpperCase())) return null;
    return entry.responseBody;
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
        this.serialize(entry.requestBody, this.isSensitiveKey),
        this.serialize(entry.requestParams, NO_MASK),
        this.serialize(entry.requestQuery, NO_MASK),
        this.serialize(this.responseBodyOf(entry), this.isSensitiveKey),
        entry.entity ?? null,
        entry.exercicio ?? null,
        entry.userId ?? null,
        entry.username ?? null,
        entry.requestId ?? null,
      ]);
    } catch (err) {
      logger.error("[AuditLogger] Failed to queue log entry:", err);
      countFalhas(1);
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

  /** Grava agora tudo que está no buffer: uma transação por arquivo de período. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer.length) return;

    const rows = this.buffer;
    this.buffer = [];
    for (const [period, grupo] of groupByPeriod(rows, this.rotation.periodOf)) {
      try {
        this.fileFor(period).flushBatch(grupo);
      } catch (err) {
        logger.error("[AuditLogger] Failed to write log entries:", err);
        countFalhas(grupo.length);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    process.off("beforeExit", this.flushOnExit);
    process.off("exit", this.flushOnExit);
    this.current.db.close();
  }
}

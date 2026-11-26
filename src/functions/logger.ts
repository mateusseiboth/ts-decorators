/**
 * Logger do pacote e dos projetos, com níveis.
 *
 * Os decorators rodam em caminho quente (uma vez por request, às vezes por campo): o nível decide
 * antes de qualquer formatação, e a mensagem preguiçosa (`() => string`) só é montada quando o
 * nível está ligado.
 *
 * Saída: uma linha por evento no STDOUT, escrita direto no `process.stdout` (nunca pelo
 * `console`, que o `patchConsole` da observabilidade redireciona para cá). Em JSON (produção,
 * lido pelo Alloy e guardado no Loki) ou legível (desenvolvimento), pelo `LOG_FORMAT`:
 *
 * ```json
 * {"ts":"...","level":"info","msg":"...","service":"api","env":"production","trace_id":"...",
 *  "span_id":"...","request_id":"...","tenant":79,"user_id":"...","porta":3000,
 *  "err":{"type":"TypeError","message":"...","stack":"..."}}
 * ```
 *
 * Nível pelo `LOG_LEVEL` (cai para o legado `TS_COMMONS_LOG_LEVEL`) ou em runtime (`setLogLevel`).
 * Chave sensível (senha, token, authorization...) sai mascarada em qualquer atributo.
 */
import { getHandlerContext, hasTenant } from "../handlers/context";
import { getOtelApi } from "../observability/otelApi";
import { redactSensitive } from "../observability/redact";
import { getRequestScope } from "../observability/requestScope";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/** Formato da linha: `json` para o coletor, `pretty` para gente lendo o terminal. */
export type LogFormat = "json" | "pretty";

/** Mensagem preguiçosa: só é construída quando o nível está ligado. */
export type LazyMessage = () => string;

type ActiveLevel = Exclude<LogLevel, "silent">;

/** Quem recebe a linha pronta (sem a quebra de linha). Troca só em teste. */
export type LogWriter = (line: string, level: ActiveLevel) => void;

export interface LoggerConfig {
  /** `service` de cada linha. Default: `OTEL_SERVICE_NAME`. */
  service?: string;
  /** `env` de cada linha. Default: `DEPLOY_ENV`, `NODE_ENV` ou `"development"`. */
  env?: string;
  format?: LogFormat;
  level?: LogLevel;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const DEFAULT_LEVEL: LogLevel = "info";
const DEFAULT_ENV = "development";
const LOG_FORMATS: readonly LogFormat[] = ["json", "pretty"];

/** Campos da linha que atributo nenhum sobrescreve. */
const CAMPOS_FIXOS = [
  "ts",
  "level",
  "msg",
  "service",
  "env",
  "trace_id",
  "span_id",
  "request_id",
  "tenant",
  "user_id",
  "err",
] as const;

const INVALID_TRACE_ID = "0".repeat(32);

const readEnv = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

const parseLevel = (raw: string | undefined): LogLevel | undefined => {
  const normalized = raw?.toLowerCase();
  return normalized && normalized in LEVEL_WEIGHT ? (normalized as LogLevel) : undefined;
};

const readEnvLevel = (): LogLevel =>
  parseLevel(readEnv("LOG_LEVEL")) ?? parseLevel(readEnv("TS_COMMONS_LOG_LEVEL")) ?? DEFAULT_LEVEL;

const readEnvName = (): string => readEnv("DEPLOY_ENV") ?? readEnv("NODE_ENV") ?? DEFAULT_ENV;

const readEnvFormat = (): LogFormat => {
  const raw = readEnv("LOG_FORMAT")?.toLowerCase() as LogFormat | undefined;
  if (raw && LOG_FORMATS.includes(raw)) return raw;
  return readEnvName() === "production" ? "json" : "pretty";
};

// Escreve direto no stdout: o `console` pode estar redirecionado para este logger.
const writeStdout: LogWriter = (line) => {
  process.stdout.write(`${line}\n`);
};

let _level: LogLevel = readEnvLevel();
let _weight = LEVEL_WEIGHT[_level];
let _format: LogFormat = readEnvFormat();
let _service: string | undefined = readEnv("OTEL_SERVICE_NAME");
let _env: string = readEnvName();
let _writer: LogWriter = writeStdout;

/** Define o nível de log em runtime. */
export function setLogLevel(level: LogLevel): void {
  _level = level;
  _weight = LEVEL_WEIGHT[level];
}

/** Nível de log corrente. */
export function getLogLevel(): LogLevel {
  return _level;
}

/** Formato corrente da linha. */
export function getLogFormat(): LogFormat {
  return _format;
}

/** `true` quando mensagens desse nível seriam impressas. */
export function isLevelEnabled(level: ActiveLevel): boolean {
  return _weight >= LEVEL_WEIGHT[level];
}

/** Troca serviço, ambiente, formato e nível (o `startObservability` chama com as opções dele). */
export function configureLogger(config: LoggerConfig): void {
  _service = config.service ?? _service;
  _env = config.env ?? _env;
  _format = config.format ?? _format;
  if (config.level) setLogLevel(config.level);
}

/** Volta tudo ao que as envs dizem (testes). */
export function resetLogger(): void {
  setLogLevel(readEnvLevel());
  _format = readEnvFormat();
  _service = readEnv("OTEL_SERVICE_NAME");
  _env = readEnvName();
}

/** Troca quem recebe as linhas (testes). Sem argumento, volta ao stdout. */
export function setLogWriter(writer: LogWriter = writeStdout): void {
  _writer = writer;
}

// ── Montagem da linha ─────────────────────────────────────────────────────────────────────────

interface SerializedError {
  type: string;
  message: string;
  stack?: string;
}

interface Partes {
  textos: string[];
  attrs: Record<string, unknown>;
  err?: SerializedError;
}

const serializeError = (error: Error): SerializedError => ({
  type: error.name || error.constructor?.name || "Error",
  message: error.message,
  ...(error.stack ? { stack: error.stack } : {}),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Como cada argumento entra na linha: erro vira `err`, objeto vira atributo, o resto é texto. */
const ARGUMENT_STRATEGIES: ReadonlyArray<{
  matches: (arg: unknown) => boolean;
  apply: (partes: Partes, arg: unknown) => void;
}> = [
  {
    matches: (arg) => arg instanceof Error,
    apply: (partes, arg) => {
      const error = arg as Error;
      partes.err ??= serializeError(error);
      if (partes.textos.length === 0) partes.textos.push(error.message);
    },
  },
  {
    matches: isRecord,
    apply: (partes, arg) => Object.assign(partes.attrs, arg),
  },
  {
    matches: () => true,
    apply: (partes, arg: unknown) => void partes.textos.push(stringifyArg(arg)),
  },
];

const stringifyArg = (arg: unknown): string => {
  if (typeof arg === "string") return arg;
  if (Array.isArray(arg)) return safeJson(redactSensitive(arg));
  return String(arg);
};

/** `bigint` vira texto e a referência repetida (ciclo em instância de classe) vira `[circular]`. */
const buildReplacer = () => {
  const vistos = new WeakSet<object>();
  return (_key: string, nested: unknown): unknown => {
    if (typeof nested === "bigint") return nested.toString();
    if (typeof nested !== "object" || nested === null) return nested;
    if (vistos.has(nested)) return "[circular]";
    vistos.add(nested);
    return nested;
  };
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, buildReplacer());
  } catch {
    return '"[não serializável]"';
  }
};

function splitArgs(args: readonly unknown[]): Partes {
  const partes: Partes = { textos: [], attrs: {} };
  for (const arg of args) {
    ARGUMENT_STRATEGIES.find((strategy) => strategy.matches(arg))!.apply(partes, arg);
  }
  return partes;
}

interface ApiComSpanAtivo {
  trace?: { getActiveSpan(): { spanContext(): { traceId: string; spanId: string } } | undefined };
}

const readTraceIds = (): Record<string, string> => {
  const api = getOtelApi() as ApiComSpanAtivo | null;
  const spanContext = api?.trace?.getActiveSpan()?.spanContext();
  if (!spanContext || spanContext.traceId === INVALID_TRACE_ID) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
};

const readUserId = (
  user: { id?: string | number; userId?: string | number } | undefined,
): string | undefined => {
  const id = user?.id ?? user?.userId;
  return id === undefined || id === null ? undefined : String(id);
};

/** O contexto do handler é a fonte; sem ele, o id que o `observeHttp` abriu. */
const readRequestFields = (): Record<string, unknown> => {
  const ctx = getHandlerContext();
  const scope = getRequestScope();
  const requestId = ctx?.requestId ?? scope?.requestId;
  const tenant = hasTenant(ctx?.entity) ? ctx.entity : scope?.tenant;
  const userId = readUserId(ctx?.user) ?? scope?.userId;
  return {
    ...(requestId ? { request_id: requestId } : {}),
    ...(hasTenant(tenant) ? { tenant } : {}),
    ...(userId ? { user_id: userId } : {}),
  };
};

const omitFixos = (attrs: Record<string, unknown>): Record<string, unknown> => {
  const livres = { ...attrs };
  for (const campo of CAMPOS_FIXOS) delete livres[campo];
  return livres;
};

/** O registro de um evento, na ordem em que os campos aparecem na linha. */
export function buildLogRecord(
  level: ActiveLevel,
  args: readonly unknown[],
): Record<string, unknown> {
  const { textos, attrs, err } = splitArgs(args);
  return {
    ts: new Date().toISOString(),
    level,
    msg: textos.join(" "),
    ...(_service ? { service: _service } : {}),
    env: _env,
    ...readTraceIds(),
    ...readRequestFields(),
    ...redactSensitive(omitFixos(attrs)),
    ...(err ? { err } : {}),
  };
}

const formatPretty = (record: Record<string, unknown>): string => {
  const { level, msg, err, ts: _ts, service: _s, env: _e, ...resto } = record;
  const atributos = Object.keys(resto).length > 0 ? ` ${safeJson(resto)}` : "";
  const pilha = (err as SerializedError | undefined)?.stack;
  const linha = `${String(level).toUpperCase()} ${String(msg)}${atributos}`;
  return pilha ? `${linha}\n${pilha}` : linha;
};

const FORMATTERS: Record<LogFormat, (record: Record<string, unknown>) => string> = {
  json: safeJson,
  pretty: formatPretty,
};

/** Grava um evento já resolvido (mensagem preguiçosa já avaliada). O `patchConsole` usa. */
export function writeLog(level: ActiveLevel, args: readonly unknown[]): void {
  if (_weight < LEVEL_WEIGHT[level]) return;
  _writer(FORMATTERS[_format](buildLogRecord(level, args)), level);
}

function emit(level: ActiveLevel, args: [LazyMessage | unknown, ...unknown[]]): void {
  if (_weight < LEVEL_WEIGHT[level]) return;
  const [first, ...rest] = args;
  writeLog(level, [typeof first === "function" ? (first as LazyMessage)() : first, ...rest]);
}

export const logger = {
  debug(...args: [LazyMessage | unknown, ...unknown[]]): void {
    emit("debug", args);
  },
  info(...args: [LazyMessage | unknown, ...unknown[]]): void {
    emit("info", args);
  },
  warn(...args: [LazyMessage | unknown, ...unknown[]]): void {
    emit("warn", args);
  },
  error(...args: [LazyMessage | unknown, ...unknown[]]): void {
    emit("error", args);
  },
};

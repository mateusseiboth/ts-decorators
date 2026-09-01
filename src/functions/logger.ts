/**
 * Logger interno do pacote, com níveis.
 *
 * Os decorators rodam em caminho quente (uma vez por request, às vezes por
 * campo): um `console.log` ali custa formatação de string + I/O síncrono em
 * TODA requisição, mesmo quando ninguém está lendo o log. Aqui o nível decide
 * antes de qualquer formatação.
 *
 * Nível padrão: `info` — os logs de diagnóstico dos decorators são `debug` e
 * ficam MUDOS até alguém pedir. Configure por env ou em runtime:
 *
 * ```ts
 * setLogLevel("debug");            // ou TS_COMMONS_LOG_LEVEL=debug
 * logger.debug(() => `caro: ${JSON.stringify(x)}`);  // só avalia se ligado
 * ```
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/** Mensagem preguiçosa: só é construída quando o nível está ligado. */
export type LazyMessage = () => string;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const DEFAULT_LEVEL: LogLevel = "info";

function readEnvLevel(): LogLevel {
  const raw = (globalThis as any).process?.env?.TS_COMMONS_LOG_LEVEL;
  const normalized = typeof raw === "string" ? (raw.toLowerCase() as LogLevel) : undefined;
  return normalized && normalized in LEVEL_WEIGHT ? normalized : DEFAULT_LEVEL;
}

let _level: LogLevel = readEnvLevel();
let _weight = LEVEL_WEIGHT[_level];

/** Define o nível de log do pacote em runtime. */
export function setLogLevel(level: LogLevel): void {
  _level = level;
  _weight = LEVEL_WEIGHT[level];
}

/** Nível de log corrente. */
export function getLogLevel(): LogLevel {
  return _level;
}

/** `true` quando mensagens desse nível seriam impressas. */
export function isLevelEnabled(level: Exclude<LogLevel, "silent">): boolean {
  return _weight >= LEVEL_WEIGHT[level];
}

function emit(
  level: Exclude<LogLevel, "silent">,
  sink: (...args: any[]) => void,
  args: [LazyMessage | unknown, ...unknown[]],
): void {
  if (_weight < LEVEL_WEIGHT[level]) return;
  const [first, ...rest] = args;
  sink(typeof first === "function" ? (first as LazyMessage)() : first, ...rest);
}

export const logger = {
  debug(...args: [LazyMessage | unknown, ...unknown[]]): void {
    emit("debug", console.log, args);
  },
  info(...args: [LazyMessage | unknown, ...unknown[]]): void {
    emit("info", console.log, args);
  },
  warn(...args: [LazyMessage | unknown, ...unknown[]]): void {
    emit("warn", console.warn, args);
  },
  error(...args: [LazyMessage | unknown, ...unknown[]]): void {
    emit("error", console.error, args);
  },
};

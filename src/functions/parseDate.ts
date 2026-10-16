/**
 * Faz o parsing de um valor arbitrário para `Date`, testando em ordem TODOS os
 * formatos conhecidos (instância de Date, epoch/timestamp, BR DD/MM/YYYY, ISO,
 * UTC, EUA YYYY-MM-DD, RFC, etc.). Só retorna `null` quando NENHUMA estratégia
 * consegue produzir uma data válida — ou seja, a data é realmente inválida.
 */

type DateStrategy = (val: any) => Date | null;

const guardValid = (d: Date): Date | null => (isNaN(d.getTime()) ? null : d);

/** Já é uma instância de Date — apenas valida. */
const fromDateInstance: DateStrategy = (val) => (val instanceof Date ? guardValid(val) : null);

const systemTimeZone = (): string => Temporal.Now.timeZoneId();

/**
 * Tipos do Temporal → epoch em milissegundos. Os tipos "plain" não carregam
 * fuso, então assumem o time zone do sistema; `PlainTime` assume o dia de hoje.
 */
const TEMPORAL_EPOCHS: [ctor: Function, toEpochMs: (val: any) => number][] = [
  [Temporal.Instant, (val: Temporal.Instant) => val.epochMilliseconds],
  [Temporal.ZonedDateTime, (val: Temporal.ZonedDateTime) => val.epochMilliseconds],
  [
    Temporal.PlainDateTime,
    (val: Temporal.PlainDateTime) => val.toZonedDateTime(systemTimeZone()).epochMilliseconds,
  ],
  [
    Temporal.PlainDate,
    (val: Temporal.PlainDate) => val.toZonedDateTime(systemTimeZone()).epochMilliseconds,
  ],
  [
    Temporal.PlainTime,
    (val: Temporal.PlainTime) =>
      Temporal.Now.plainDateISO().toPlainDateTime(val).toZonedDateTime(systemTimeZone())
        .epochMilliseconds,
  ],
];

/** Qualquer valor do Temporal (ZonedDateTime, Instant, Plain*). */
const fromTemporal: DateStrategy = (val) => {
  const match = TEMPORAL_EPOCHS.find(([ctor]) => val instanceof ctor);
  return match ? guardValid(new Date(match[1](val))) : null;
};

/**
 * Epoch numérico (TIMESTAMP/EPOCH), em segundos ou milissegundos.
 * Aceita number ou string puramente numérica. Epoch em segundos ocupa até
 * 10 dígitos no intervalo usual; valores com 11 ou mais são milissegundos.
 *
 * A fronteira não pode ser 1e11: epochs negativos em milissegundos de datas
 * anteriores a 1970 podem ter 11 dígitos (ex.: -69451200000 = 1967). Se esse
 * valor for tratado como segundos, vira o ano -231.
 */
const fromEpoch: DateStrategy = (val) => {
  const raw = String(val).trim();
  const isNumeric = typeof val === "number" || /^-?\d+$/.test(raw);
  if (!isNumeric) return null;

  const num = Number(val);
  if (!Number.isFinite(num)) return null;

  const millis = Math.abs(num) < 1e10 ? num * 1000 : num;
  return guardValid(new Date(millis));
};

/** BR: DD/MM/YYYY, opcionalmente com hora `HH:mm[:ss]`. */
const fromBrazilian: DateStrategy = (val) => {
  const match = String(val)
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;

  const [, dd, mm, yyyy, hh = "0", min = "0", ss = "0"] = match;
  const day = Number(dd);
  const month = Number(mm) - 1;
  const d = new Date(Number(yyyy), month, day, Number(hh), Number(min), Number(ss));

  // Rejeita datas com overflow (ex.: 31/02) que o Date normalizaria silenciosamente.
  const consistent = d.getDate() === day && d.getMonth() === month;
  return consistent ? guardValid(d) : null;
};

/**
 * ISO só com a data (`YYYY-MM-DD`): o dia informado, à meia-noite do fuso do processo.
 *
 * O `new Date("2026-01-15")` lê em UTC, e em qualquer fuso negativo isso é a noite do dia 14:
 * a data mudava de dia. Vale a mesma leitura do formato brasileiro e dos conversores do Temporal.
 */
const fromIsoDateOnly: DateStrategy = (val) => {
  const match = String(val)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const [, yyyy, mm, dd] = match;
  const day = Number(dd);
  const month = Number(mm) - 1;
  const d = new Date(Number(yyyy), month, day);

  // Rejeita datas com overflow (ex.: 2026-02-31) que o Date normalizaria silenciosamente.
  const consistent = d.getDate() === day && d.getMonth() === month;
  return consistent ? guardValid(d) : null;
};

/** ISO 8601 com hora, UTC, RFC e demais formatos nativos. */
const fromNative: DateStrategy = (val) => guardValid(new Date(val));

/**
 * Valor que nenhuma estratégia lê devolve `null`, nunca lança. O `new Date()` e o `String()`
 * lançam para `Symbol` e para os tipos do Temporal sem data (`Duration`, `PlainYearMonth`...).
 */
const withoutThrow =
  (strategy: DateStrategy): DateStrategy =>
  (val) => {
    try {
      return strategy(val);
    } catch {
      return null;
    }
  };

const isIsoDateOnly = (val: unknown): boolean =>
  typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val.trim());

const strategies: DateStrategy[] = [
  fromDateInstance,
  fromTemporal,
  fromEpoch,
  fromBrazilian,
  fromIsoDateOnly,
  fromNative,
].map(withoutThrow);

export function parseDate(val: any): Date | null {
  if (val === null || val === undefined) return null;
  // Sentinela histórica: 0 e "0" representam "sem data".
  if (val === 0 || val === "0") return null;
  if (typeof val === "string" && val.trim() === "") return null;
  // Booleano não é data: o `new Date(true)` devolveria 1 ms depois de 1970.
  if (typeof val === "boolean") return null;
  // Data ISO que não fecha (`2026-02-31`) é inválida: o `new Date()` a empurraria para março.
  if (isIsoDateOnly(val)) return withoutThrow(fromIsoDateOnly)(val);

  for (const strategy of strategies) {
    const parsed = strategy(val);
    if (parsed) return parsed;
  }

  return null;
}

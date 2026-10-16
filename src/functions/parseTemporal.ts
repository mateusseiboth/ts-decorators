/**
 * Conversores para os tipos do `Temporal`. Cada função aceita QUALQUER formato
 * de data conhecido (string ISO/BR/RFC, epoch, `Date`, outro tipo do Temporal,
 * property bag) e devolve o tipo pedido — ou `null` quando nenhuma estratégia
 * consegue interpretar o valor, no mesmo contrato do `parseDate`.
 *
 * A regra de ouro do `ZonedDateTime`: o time zone que veio na string é
 * PRESERVADO (`[America/Sao_Paulo]` continua `[America/Sao_Paulo]`, `-03:00`
 * continua `-03:00`, `Z` vira `UTC`). Só quando o valor não carrega fuso nenhum
 * (BR, `Date`, epoch, ISO sem offset) é que o time zone do sistema entra.
 */
import { parseDate } from "./parseDate";

const systemTimeZone = (): string => Temporal.Now.timeZoneId();

/** Executa a conversão nativa do Temporal tratando `RangeError`/`TypeError` como "não é esse formato". */
const attempt = <T>(build: () => T): T | null => {
  try {
    return build();
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// ZonedDateTime — a âncora de onde todos os outros tipos são derivados
// ---------------------------------------------------------------------------

type ZonedStrategy = (val: any) => Temporal.ZonedDateTime | null;

/** Já é um ZonedDateTime — nada a fazer. */
const fromZonedInstance: ZonedStrategy = (val) =>
  val instanceof Temporal.ZonedDateTime ? val : null;

/** Outros tipos do Temporal: o que não tem fuso assume o do sistema. */
const fromTemporalInstance: ZonedStrategy = (val) => {
  if (val instanceof Temporal.Instant) return val.toZonedDateTimeISO(systemTimeZone());
  if (val instanceof Temporal.PlainDateTime) return val.toZonedDateTime(systemTimeZone());
  if (val instanceof Temporal.PlainDate) return val.toZonedDateTime(systemTimeZone());
  return null;
};

/** String/objeto que o próprio Temporal entende (inclui `[America/Sao_Paulo]` e property bag). */
const fromNativeZoned: ZonedStrategy = (val) => {
  const parseable = typeof val === "string" || (typeof val === "object" && !(val instanceof Date));
  return parseable ? attempt(() => Temporal.ZonedDateTime.from(val)) : null;
};

// Exige um separador de hora (`T`, `t` ou espaço, como vem dos bancos) antes do
// offset, para não confundir `2024-01-15` com um offset `-01-15`.
const TRAILING_OFFSET = /[T ].*?(Z|[+-]\d{2}:?\d{2})$/i;

const normalizeOffset = (offset: string): string => {
  if (offset.toUpperCase() === "Z") return "UTC";
  return offset.includes(":") ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`;
};

/**
 * ISO com offset mas SEM anotação de time zone (`2024-01-15T10:00:00-03:00`).
 * O Temporal recusa esse formato no `ZonedDateTime.from`, então o offset da
 * própria string vira o time zone — é o que preserva a hora que o cliente mandou.
 */
const fromOffsetString: ZonedStrategy = (val) => {
  if (typeof val !== "string") return null;
  const offset = val.trim().match(TRAILING_OFFSET)?.[1];
  if (!offset) return null;

  const instant = attempt(() => Temporal.Instant.from(val.trim()));
  return instant && attempt(() => instant.toZonedDateTimeISO(normalizeOffset(offset)));
};

/**
 * ISO sem fuso nenhum (`2024-01-15`, `2024-01-15T10:00:00`): a hora de parede é
 * lida como está e ganha o time zone do sistema. Precisa vir antes do parseDate
 * porque `new Date("2024-01-15")` assume UTC e trocaria o DIA em fusos negativos.
 */
const fromPlainString: ZonedStrategy = (val) => {
  if (typeof val !== "string") return null;
  const plain = attempt(() => Temporal.PlainDateTime.from(val.trim()));
  return plain && attempt(() => plain.toZonedDateTime(systemTimeZone()));
};

/** Último recurso: tudo que o parseDate resolve (BR `DD/MM/YYYY`, epoch, RFC, `Date`). */
const fromParsedDate: ZonedStrategy = (val) => {
  const date = parseDate(val);
  return date && date.toTemporalInstant().toZonedDateTimeISO(systemTimeZone());
};

const zonedStrategies: ZonedStrategy[] = [
  fromZonedInstance,
  fromTemporalInstance,
  fromNativeZoned,
  fromOffsetString,
  fromPlainString,
  fromParsedDate,
];

export function parseZonedDateTime(val: any): Temporal.ZonedDateTime | null {
  if (val === null || val === undefined) return null;

  for (const strategy of zonedStrategies) {
    const parsed = strategy(val);
    if (parsed) return parsed;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Demais tipos: formato nativo primeiro, ZonedDateTime como âncora depois
// ---------------------------------------------------------------------------

interface TemporalKind<T> {
  /** Construtor do tipo — usado para instanceof e para o @Field(Temporal.X). */
  ctor: abstract new (...args: any[]) => T;
  /** Conversão nativa do próprio Temporal (`Temporal.X.from`). */
  from: (raw: any) => T;
  /** Derivação a partir da âncora, para os formatos que o `from` não aceita. */
  fromZoned: (zoned: Temporal.ZonedDateTime) => T;
  /** Recusa a âncora quando o valor não carrega a informação que o tipo pede. */
  canDeriveFromZoned?: (val: any) => boolean;
}

function parseKind<T>(kind: TemporalKind<T>, val: any): T | null {
  if (val === null || val === undefined) return null;
  if (val instanceof kind.ctor) return val;

  const native = attempt(() => kind.from(val));
  if (native) return native;

  if (kind.canDeriveFromZoned && !kind.canDeriveFromZoned(val)) return null;

  const zoned = parseZonedDateTime(val);
  return zoned && attempt(() => kind.fromZoned(zoned));
}

const instantKind: TemporalKind<Temporal.Instant> = {
  ctor: Temporal.Instant,
  from: (raw) => Temporal.Instant.from(raw),
  fromZoned: (zoned) => zoned.toInstant(),
};

const plainDateKind: TemporalKind<Temporal.PlainDate> = {
  ctor: Temporal.PlainDate,
  from: (raw) => Temporal.PlainDate.from(raw),
  fromZoned: (zoned) => zoned.toPlainDate(),
};

const plainDateTimeKind: TemporalKind<Temporal.PlainDateTime> = {
  ctor: Temporal.PlainDateTime,
  from: (raw) => Temporal.PlainDateTime.from(raw),
  fromZoned: (zoned) => zoned.toPlainDateTime(),
};

const plainTimeKind: TemporalKind<Temporal.PlainTime> = {
  ctor: Temporal.PlainTime,
  from: (raw) => Temporal.PlainTime.from(raw),
  fromZoned: (zoned) => zoned.toPlainTime(),
  // "2024-01-15" não tem hora nenhuma: derivar da âncora devolveria a
  // meia-noite (ou pior, a hora do deslocamento de fuso) como se fosse o dado.
  canDeriveFromZoned: (val) =>
    typeof val !== "string" || val.includes(":") || /^-?\d+$/.test(val.trim()),
};

const plainYearMonthKind: TemporalKind<Temporal.PlainYearMonth> = {
  ctor: Temporal.PlainYearMonth,
  from: (raw) => Temporal.PlainYearMonth.from(raw),
  fromZoned: (zoned) => zoned.toPlainDate().toPlainYearMonth(),
};

const plainMonthDayKind: TemporalKind<Temporal.PlainMonthDay> = {
  ctor: Temporal.PlainMonthDay,
  from: (raw) => Temporal.PlainMonthDay.from(raw),
  fromZoned: (zoned) => zoned.toPlainDate().toPlainMonthDay(),
};

export const parseInstant = (val: any): Temporal.Instant | null => parseKind(instantKind, val);
export const parsePlainDate = (val: any): Temporal.PlainDate | null =>
  parseKind(plainDateKind, val);
export const parsePlainDateTime = (val: any): Temporal.PlainDateTime | null =>
  parseKind(plainDateTimeKind, val);
export const parsePlainTime = (val: any): Temporal.PlainTime | null =>
  parseKind(plainTimeKind, val);
export const parsePlainYearMonth = (val: any): Temporal.PlainYearMonth | null =>
  parseKind(plainYearMonthKind, val);
export const parsePlainMonthDay = (val: any): Temporal.PlainMonthDay | null =>
  parseKind(plainMonthDayKind, val);

// ---------------------------------------------------------------------------
// Duration — não deriva de data, tem estratégias próprias
// ---------------------------------------------------------------------------

type DurationStrategy = (val: any) => Temporal.Duration | null;

const durationStrategies: DurationStrategy[] = [
  (val) => (val instanceof Temporal.Duration ? val : null),
  // número solto é lido como milissegundos (mesma unidade de setTimeout/Date).
  (val) =>
    typeof val === "number" && Number.isFinite(val)
      ? Temporal.Duration.from({ milliseconds: val })
      : null,
  (val) => attempt(() => Temporal.Duration.from(val)),
];

export function parseDuration(val: any): Temporal.Duration | null {
  if (val === null || val === undefined) return null;

  for (const strategy of durationStrategies) {
    const parsed = strategy(val);
    if (parsed) return parsed;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Metadados: nome do tipo no @Field, construtor e "é um dia no calendário?"
// ---------------------------------------------------------------------------

export type TemporalConverter = (val: any) => any;

/** Nome canônico (minúsculo, como o reflect-metadata devolve) → conversor. */
const CONVERTERS = {
  instant: parseInstant,
  zoneddatetime: parseZonedDateTime,
  plaindate: parsePlainDate,
  plaindatetime: parsePlainDateTime,
  plaintime: parsePlainTime,
  plainyearmonth: parsePlainYearMonth,
  plainmonthday: parsePlainMonthDay,
  duration: parseDuration,
} satisfies Record<string, TemporalConverter>;

/** Nome canônico do tipo, como sai do reflect-metadata: `"zoneddatetime"`. */
export type TemporalTypeName = keyof typeof CONVERTERS;

/** Apelidos aceitos no @Field, além do nome canônico e do prefixo `Temporal.`. */
const ALIASES = {
  zoned: "zoneddatetime",
  datetime: "plaindatetime",
  time: "plaintime",
  yearmonth: "plainyearmonth",
  monthday: "plainmonthday",
} satisfies Record<string, TemporalTypeName>;

/** Apelido curto aceito no @Field: `"time"`, `"datetime"`… */
export type TemporalTypeAlias = keyof typeof ALIASES;

/** Construtores aceitos direto no @Field — a fonte de verdade dos nomes qualificados. */
const CONSTRUCTORS = {
  Instant: Temporal.Instant,
  ZonedDateTime: Temporal.ZonedDateTime,
  PlainDate: Temporal.PlainDate,
  PlainDateTime: Temporal.PlainDateTime,
  PlainTime: Temporal.PlainTime,
  PlainYearMonth: Temporal.PlainYearMonth,
  PlainMonthDay: Temporal.PlainMonthDay,
  Duration: Temporal.Duration,
} satisfies Record<string, Function>;

/** `Temporal.ZonedDateTime`, `Temporal.PlainDate`… o valor, não o tipo da instância. */
export type TemporalConstructor = (typeof CONSTRUCTORS)[keyof typeof CONSTRUCTORS];

/**
 * Tudo que o @Field aceita como tipo do Temporal, em string:
 * `"zoneddatetime"` | `"Temporal.ZonedDateTime"` | `"zoned"` | …
 */
export type TemporalFieldType =
  | TemporalTypeName
  | TemporalTypeAlias
  | `Temporal.${keyof typeof CONSTRUCTORS}`;

const TEMPORAL_CONSTRUCTORS = new Map<Function, TemporalTypeName>(
  Object.entries(CONSTRUCTORS).map(([name, ctor]) => [
    ctor,
    name.toLowerCase() as TemporalTypeName,
  ]),
);

/** `"Temporal.ZonedDateTime"`, `"zoned"`, `"ZonedDateTime"` → `"zoneddatetime"`. */
const canonicalKey = (type: string): string => {
  const key = type
    .trim()
    .toLowerCase()
    .replace(/^temporal\./, "");
  return (ALIASES as Record<string, string>)[key] ?? key;
};

/** Conversor do tipo declarado no @Field, ou `undefined` se não for tipo do Temporal. */
export function getTemporalConverter(type: string | undefined): TemporalConverter | undefined {
  if (!type) return undefined;
  return (CONVERTERS as Record<string, TemporalConverter>)[canonicalKey(type)];
}

/** Nome do tipo para `@Field(Temporal.PlainDate)`, ou `undefined` para qualquer outra classe. */
export function temporalTypeName(ctor: Function): TemporalTypeName | undefined {
  return TEMPORAL_CONSTRUCTORS.get(ctor);
}

export function isTemporalConstructor(ctor: unknown): boolean {
  return typeof ctor === "function" && TEMPORAL_CONSTRUCTORS.has(ctor);
}

/** Tipos que representam um dia do calendário — usados nos filtros de data do getWhere. */
const DATE_LIKE_TYPES = new Set(["date", "instant", "zoneddatetime", "plaindate", "plaindatetime"]);

export function isDateLikeFieldType(type: string | undefined): boolean {
  if (!type) return false;
  return DATE_LIKE_TYPES.has(canonicalKey(type));
}

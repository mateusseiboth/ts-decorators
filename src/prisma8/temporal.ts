/**
 * A fronteira de CODECS do Prisma 8: datas e enums.
 *
 * Os codecs temporais do Prisma 8 trabalham com `Temporal`, não com `Date`: `timestamp(p)` lê e
 * escreve `Temporal.PlainDateTime`, `timestamptz(p)` `Temporal.Instant`, `date` `Temporal.PlainDate`.
 * Um `Date` chegando ao codec falha com `RUNTIME.ENCODE_FAILED`.
 *
 * O que este módulo fixa, para o resto do sistema não mudar de contrato:
 * - Escrita e filtro aceitam `Date`, ISO string ou `Temporal`; a conversão é pelo CODEC da coluna
 *   (`encodeForCodec`). Um `timestamp(p)` sem fuso guarda o horário UTC, como o Prisma 7 sempre
 *   gravou — o `Date` vira o wall time em UTC.
 * - Leitura serializa `Temporal` no MESMO ISO com `Z` que o Prisma 7 mandava para o cliente
 *   (`temporalToIso`), pelo `convertBigIntValues`. `PlainDateTime.toJSON()` sozinho perde o `Z`
 *   e o navegador leria o horário como local.
 */

import {
  columnOptionsFor,
  decodeFieldValue,
  decodeTreeByModel,
  encodeFieldValue,
  prismaModelNameOf,
  requireMappedModels,
} from "../fields/rowFields";
import { getEnumLabels, isNumericAsNumber } from "./client";

/** O que o proxy de campo e o contrato dizem sobre a coluna. */
export interface FieldCodec {
  codecId?: string;
  typeParams?: { typeName?: string; precision?: number };
}

const TEMPORAL_TAG = "Temporal.";

type AnyTemporal =
  | Temporal.PlainDateTime
  | Temporal.Instant
  | Temporal.ZonedDateTime
  | Temporal.PlainDate
  | Temporal.PlainTime;

export function isTemporal(value: unknown): value is AnyTemporal {
  const tag = (value as { [Symbol.toStringTag]?: unknown } | null)?.[Symbol.toStringTag];
  return typeof tag === "string" && tag.startsWith(TEMPORAL_TAG);
}

function instantOf(value: Date | string | number): Temporal.Instant {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(ms))
    throw new Error(`[@mateusseiboth/ts-decorators] Data inválida: ${String(value)}`);
  return Temporal.Instant.fromEpochMilliseconds(ms);
}

function utcOf(value: Date | string | number): Temporal.ZonedDateTime {
  return instantOf(value).toZonedDateTimeISO("UTC");
}

type Encoder = (value: Date | string | number) => AnyTemporal;

/** Codec temporal do Postgres → como um `Date`/ISO vira o `Temporal` que ele aceita. */
const ENCODERS: Record<string, Encoder> = {
  "pg/timestamp-temporal@1": (value) => utcOf(value).toPlainDateTime(),
  "pg/timestamptz-temporal@1": (value) => instantOf(value),
  "pg/date-temporal@1": (value) => utcOf(value).toPlainDate(),
};

export function isTemporalCodec(codecId: string | undefined): boolean {
  return !!codecId && codecId in ENCODERS;
}

const ENUM_CODEC = "pg/enum@1";

function encodeTemporal(value: unknown, codecId: string | undefined): unknown {
  const encode = codecId ? ENCODERS[codecId] : undefined;
  if (!encode || value == null || isTemporal(value)) return value;
  if (value instanceof Date || typeof value === "string" || typeof value === "number") {
    return encode(value);
  }
  return value;
}

/** Rótulo do enum → valor do banco; valor já gravado (ou rótulo desconhecido) passa direto. */
function encodeEnum(value: unknown, typeName: string | undefined): unknown {
  if (typeof value !== "string" || !typeName) return value;
  return getEnumLabels()[typeName]?.[value] ?? value;
}

/** Valor do banco → rótulo do enum; sem mapa, o valor fica como veio. */
function decodeEnum(value: unknown, typeName: string | undefined): unknown {
  if (typeof value !== "string" || !typeName) return value;
  const labels = getEnumLabels()[typeName];
  if (!labels) return value;
  const label = Object.keys(labels).find((key) => labels[key] === value);
  return label ?? value;
}

const BIGINT_CODEC = "pg/int8@1";

/**
 * `pg/int8@1` só aceita `bigint` em JS, e o que chega da query string (`sequencial=728`) e de
 * quase todo payload é `number` ou string numérica. Inteiro vira `bigint`; o que não é inteiro
 * segue como veio, para o codec recusar com a mensagem dele.
 */
function encodeBigint(value: unknown): unknown {
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) return BigInt(value.trim());
  return value;
}

const NUMERIC_CODEC = "pg/numeric@1";

/**
 * `pg/numeric@1` exige texto numérico CANÔNICO (`"412.66"`) — `number` é recusado no caminho
 * JSON, e `String(1e-7)` dá `"1e-7"`, que ele também recusa. O número vira o texto decimal; a
 * coluna arredonda na escala dela.
 */
const DECIMAL_SEM_EXPOENTE = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  maximumFractionDigits: 20,
});

function encodeNumeric(value: unknown): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  const texto = String(value);
  return /e/i.test(texto) ? DECIMAL_SEM_EXPOENTE.format(value) : texto;
}

/** Texto decimal do banco → `number`, só com `numericAsNumber` ligado. */
function decodeNumeric(value: unknown): unknown {
  if (!isNumericAsNumber() || typeof value !== "string") return value;
  return Number(value);
}

type CodecEncoder = (value: unknown, spec: FieldCodec) => unknown;

const ENCODERS_POR_CODEC: Record<string, CodecEncoder> = {
  [ENUM_CODEC]: (value, spec) => encodeEnum(value, spec.typeParams?.typeName),
  [BIGINT_CODEC]: (value) => encodeBigint(value),
  [NUMERIC_CODEC]: (value) => encodeNumeric(value),
};

type CodecDecoder = (value: unknown, spec: FieldCodec) => unknown;

const DECODERS_POR_CODEC: Record<string, CodecDecoder> = {
  [ENUM_CODEC]: (value, spec) => decodeEnum(value, spec.typeParams?.typeName),
  [NUMERIC_CODEC]: (value) => decodeNumeric(value),
};

/**
 * Prepara um valor para a coluna: `Date`/ISO/epoch viram o `Temporal` do codec temporal, rótulo
 * de enum vira o valor do banco, inteiro vira `bigint` em coluna `int8`, o resto passa como está.
 */
export function encodeForCodec(value: unknown, codec: FieldCodec | string | undefined): unknown {
  const spec = typeof codec === "string" ? { codecId: codec } : codec;
  const encoder = spec?.codecId ? ENCODERS_POR_CODEC[spec.codecId] : undefined;
  if (encoder) return encoder(value, spec!);
  return encodeTemporal(value, spec?.codecId);
}

/**
 * O inverso de `encodeForCodec` para o que a leitura precisa: valor de enum → rótulo e, com
 * `numericAsNumber`, `numeric` → `number`.
 */
export function decodeForCodec(value: unknown, codec: FieldCodec | undefined): unknown {
  const decoder = codec?.codecId ? DECODERS_POR_CODEC[codec.codecId] : undefined;
  return decoder ? decoder(value, codec!) : value;
}

const ISO_SECONDS = { fractionalSecondDigits: 3 } as const;

type Serializer = (value: AnyTemporal) => string;

/** Cada tipo Temporal → o ISO que o Prisma 7 produzia para a mesma coluna. */
const SERIALIZERS: Record<string, Serializer> = {
  "Temporal.PlainDateTime": (value) =>
    `${(value as Temporal.PlainDateTime).toString(ISO_SECONDS)}Z`,
  "Temporal.Instant": (value) => (value as Temporal.Instant).toString(ISO_SECONDS),
  "Temporal.ZonedDateTime": (value) =>
    (value as Temporal.ZonedDateTime).toInstant().toString(ISO_SECONDS),
  "Temporal.PlainDate": (value) => `${(value as Temporal.PlainDate).toString()}T00:00:00.000Z`,
  "Temporal.PlainTime": (value) => (value as Temporal.PlainTime).toString(),
};

/** `Temporal` → ISO com `Z` (o mesmo texto que `Date.toISOString()` daria no Prisma 7). */
export function temporalToIso(value: AnyTemporal): string {
  const tag = (value as { [Symbol.toStringTag]: string })[Symbol.toStringTag];
  const serialize = SERIALIZERS[tag];
  if (!serialize) return String(value);
  return serialize(value);
}

/** `Temporal` → `Date`, para quem ainda faz conta com `Date`/dayjs. */
export function temporalToDate(value: AnyTemporal): Date {
  return new Date(temporalToIso(value));
}

/** Converte, em profundidade, todo `Temporal` de um resultado para `Date`. */
export function datesFromTemporal<T>(data: T): T {
  if (isTemporal(data)) return temporalToDate(data) as unknown as T;
  if (Array.isArray(data)) return data.map((item) => datesFromTemporal(item)) as unknown as T;
  if (data !== null && typeof data === "object" && !(data instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      out[key] = datesFromTemporal(value);
    }
    return out as T;
  }
  return data;
}

interface ContractField {
  type?: FieldCodec;
}

interface ContractModel {
  fields?: Record<string, ContractField>;
  relations?: Record<string, { to?: { model?: string; namespace?: string } }>;
}

interface ContractLike {
  domain?: { namespaces?: Record<string, { models?: Record<string, ContractModel> }> };
}

interface CollectionMeta {
  contract?: ContractLike;
  modelName?: string;
  namespaceId?: string;
}

function modelOf(contract: ContractLike | undefined, namespace: string, model: string) {
  return contract?.domain?.namespaces?.[namespace]?.models?.[model];
}

/**
 * Codec de cada coluna do model, lido do contrato que a coleção carrega. Vazio quando a coleção
 * não expõe contrato (fakes de teste).
 */
export function fieldCodecs(collection: unknown): Record<string, FieldCodec | undefined> {
  const meta = collection as CollectionMeta;
  const model = modelOf(meta.contract, meta.namespaceId ?? "public", meta.modelName ?? "");
  if (!model?.fields) return {};
  return Object.fromEntries(Object.entries(model.fields).map(([field, def]) => [field, def.type]));
}

/**
 * O caminho único de gravação: cada coluna do payload passa pelo `@Field` do model (normaliza e
 * cifra, quando declarado) e depois pelo codec da coluna, pelo contrato da coleção. Aceita a
 * coleção do Prisma 8 e o delegate do Prisma 7 (que não tem codec, só o `@Field`).
 */
export function encodeRowForCollection<T extends Record<string, unknown>>(
  collection: unknown,
  row: T,
): T {
  requireMappedModels(collection);
  const codecs = fieldCodecs(collection);
  const options = columnOptionsFor(prismaModelNameOf(collection));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = encodeForCodec(encodeFieldValue(options?.[key], value), codecs[key]);
  }
  return out as T;
}

function decodeModelRow(
  contract: ContractLike | undefined,
  namespace: string,
  modelName: string,
  row: unknown,
): unknown {
  if (Array.isArray(row))
    return row.map((item) => decodeModelRow(contract, namespace, modelName, item));
  if (!row || typeof row !== "object" || isTemporal(row) || row instanceof Date) return row;
  const model = modelOf(contract, namespace, modelName);
  if (!model) return row;
  const options = columnOptionsFor(modelName);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    const relation = model.relations?.[key];
    out[key] = relation
      ? decodeModelRow(
          contract,
          relation.to?.namespace ?? namespace,
          relation.to?.model ?? "",
          value,
        )
      : decodeFieldValue(options?.[key], key, decodeForCodec(value, model.fields?.[key]?.type));
  }
  return out;
}

/**
 * O caminho único de leitura: valor de enum vira rótulo e campo cifrado é decifrado em toda a
 * árvore (linha, listas, relações incluídas), seguindo as relações do contrato para decodificar
 * cada model com o SEU mapa. Sem contrato (delegate do Prisma 7), só o `@Field` do model vale, e
 * as relações seguem o `@Field(Model)`.
 */
export function decodeRowsForCollection<T>(collection: unknown, rows: T): T {
  requireMappedModels(collection);
  const meta = collection as CollectionMeta;
  if (!meta?.contract) return decodeTreeByModel(prismaModelNameOf(collection), rows) as T;
  return decodeModelRow(
    meta.contract,
    meta.namespaceId ?? "public",
    meta.modelName ?? "",
    rows,
  ) as T;
}

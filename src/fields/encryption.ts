/**
 * Cifra de campo (`@Field({ encrypted: true })`): AES-256-GCM, IV aleatório por valor, e o texto
 * gravado no formato `enc:v1:<id da chave>:<iv>:<dado + tag>` (base64url).
 *
 * O id da chave é a IMPRESSÃO DIGITAL dela (8 primeiros bytes do SHA-256, em base64url), não o
 * rótulo da configuração. Uma chave errada no ambiente nunca casa com o id gravado: a leitura
 * falha com "chave não configurada" em vez de tentar decifrar com a chave errada, e o dado fica
 * intacto esperando a chave certa.
 *
 * Por que `node:crypto` e não `crypto.subtle`: o WebCrypto só tem API assíncrona, e o caminho de
 * gravação e leitura do pacote (`encodeRowForCollection`, `readRows`, `decodeRowsForCollection`)
 * é síncrono e chamado em linha por todo DAO dos apps. Torná-lo assíncrono quebraria cada
 * chamada existente. O `node:crypto` do Bun é nativo (BoringSSL), síncrono, e o algoritmo e o
 * formato são os mesmos: o texto gravado é decifrável pelo WebCrypto, e vice-versa.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FINGERPRINT_BYTES = 8;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Por que a cifra recusou. */
export type EncryptionErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_KEY"
  | "UNKNOWN_KEY"
  | "TAMPERED"
  | "INVALID_FORMAT"
  | "UNMAPPED_MODEL";

/** Erro da cifra de campo. É erro de servidor (configuração ou dado), não do usuário. */
export class EncryptionError extends Error {
  constructor(
    readonly code: EncryptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EncryptionError";
  }
}

export interface ConfigureEncryptionOptions {
  /**
   * As chaves conhecidas, por rótulo: 32 bytes em base64 ou base64url, normalmente lidos de
   * variável de ambiente (`{ k1: process.env.FIELD_KEY_K1 }`). A leitura aceita qualquer uma.
   */
  keys: Record<string, string | undefined>;
  /** O rótulo da chave que GRAVA. Obrigatório: a gravação nunca escolhe a chave sozinha. */
  current: string;
}

/** Uma chave carregada, como `listEncryptionKeys` mostra. */
export interface EncryptionKeyInfo {
  /** O rótulo da configuração. */
  label: string;
  /** A impressão digital, que é o que vai no texto gravado. */
  id: string;
  /** É a chave que grava. */
  current: boolean;
}

interface LoadedKey {
  label: string;
  id: string;
  key: Buffer;
}

interface EncryptionState {
  byId: Map<string, LoadedKey>;
  current: LoadedKey;
  keys: LoadedKey[];
}

let state: EncryptionState | undefined;

const describeField = (field?: string) => (field ? `campo "${field}"` : "campo cifrado");

const decodeKey = (label: string, raw: string | undefined): Buffer => {
  if (!raw?.trim()) {
    throw new EncryptionError(
      "INVALID_KEY",
      `[@mateusseiboth/ts-decorators] A chave "${label}" está vazia. Confira a variável de ambiente que a carrega.`,
    );
  }
  const key = BASE64.test(raw.trim()) ? Buffer.from(raw.trim(), "base64") : Buffer.alloc(0);
  if (key.length !== KEY_BYTES) {
    throw new EncryptionError(
      "INVALID_KEY",
      `[@mateusseiboth/ts-decorators] A chave "${label}" precisa ter 32 bytes em base64 (gere com: openssl rand -base64 32).`,
    );
  }
  return key;
};

const fingerprintOf = (key: Buffer): string =>
  createHash("sha256").update(key).digest().subarray(0, FINGERPRINT_BYTES).toString("base64url");

/** A impressão digital da chave (o id gravado no texto cifrado). */
export function keyFingerprint(key: string): string {
  return fingerprintOf(decodeKey("informada", key));
}

const loadKey = ([label, raw]: [string, string | undefined]): LoadedKey => {
  const key = decodeKey(label, raw);
  return { label, id: fingerprintOf(key), key };
};

/**
 * Carrega as chaves da cifra de campo. Chame uma vez no boot, antes da primeira gravação ou
 * leitura de campo cifrado. Chamar de novo troca a configuração inteira.
 */
export function configureEncryption(options: ConfigureEncryptionOptions): void {
  const keys = Object.entries(options.keys).map(loadKey);
  if (!keys.length) {
    throw new EncryptionError(
      "INVALID_KEY",
      "[@mateusseiboth/ts-decorators] configureEncryption precisa de ao menos uma chave em keys.",
    );
  }
  const current = keys.find((key) => key.label === options.current);
  if (!current) {
    throw new EncryptionError(
      "INVALID_KEY",
      `[@mateusseiboth/ts-decorators] A chave atual "${options.current}" não está em keys.`,
    );
  }
  const byId = new Map<string, LoadedKey>();
  for (const key of keys) if (!byId.has(key.id)) byId.set(key.id, key);
  state = { byId, current, keys };
}

/** Esquece a configuração (testes). */
export function resetEncryption(): void {
  state = undefined;
}

/** As chaves carregadas, com a impressão digital de cada uma. Vazio sem configuração. */
export function listEncryptionKeys(): EncryptionKeyInfo[] {
  return (state?.keys ?? []).map((key) => ({
    label: key.label,
    id: key.id,
    current: key === state?.current,
  }));
}

const requireState = (): EncryptionState => {
  if (state) return state;
  throw new EncryptionError(
    "NOT_CONFIGURED",
    "[@mateusseiboth/ts-decorators] Campo cifrado sem chave: chame configureEncryption({ keys, current }) no boot, antes da primeira gravação ou leitura.",
  );
};

/** O texto tem o prefixo da cifra (`enc:v1:`). Não confere a chave nem a integridade. */
export function isEncryptedValue(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

const withBigintAsText = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

interface ParsedValue {
  id: string;
  iv: Buffer;
  data: Buffer;
}

const parseEncrypted = (value: string, field?: string): ParsedValue => {
  const [id, iv, data, ...resto] = value.slice(PREFIX.length).split(":");
  if (!id || !iv || !data || resto.length) {
    throw new EncryptionError(
      "INVALID_FORMAT",
      `[@mateusseiboth/ts-decorators] O valor do ${describeField(field)} começa com enc:v1: mas não está no formato enc:v1:<chave>:<iv>:<dado>.`,
    );
  }
  return { id, iv: Buffer.from(iv, "base64url"), data: Buffer.from(data, "base64url") };
};

const requireKey = (current: EncryptionState, id: string, field?: string): LoadedKey => {
  const key = current.byId.get(id);
  if (key) return key;
  throw new EncryptionError(
    "UNKNOWN_KEY",
    `[@mateusseiboth/ts-decorators] Chave ${id} não configurada: o ${describeField(field)} foi cifrado com ela. Inclua essa chave em configureEncryption; listEncryptionKeys() mostra a impressão digital de cada chave carregada.`,
  );
};

const openWith = (key: LoadedKey, parsed: ParsedValue, field?: string): unknown => {
  try {
    const decipher = createDecipheriv(ALGORITHM, key.key, parsed.iv);
    decipher.setAuthTag(parsed.data.subarray(parsed.data.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(parsed.data.subarray(0, parsed.data.length - TAG_BYTES)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw new EncryptionError(
      "TAMPERED",
      `[@mateusseiboth/ts-decorators] O valor do ${describeField(field)} foi alterado ou está corrompido: a verificação do AES-GCM falhou.`,
    );
  }
};

/**
 * Decifra o valor gravado. `null`/`undefined` passam intactos, e o valor sem o prefixo `enc:v1:`
 * (dado legado, gravado antes da cifra) volta como está. Chave desconhecida, dado adulterado ou
 * formato quebrado lançam `EncryptionError`: nunca devolve lixo.
 */
export function decryptValue(value: unknown, field?: string): unknown {
  if (value == null) return value;
  const current = requireState();
  if (!isEncryptedValue(value)) return value;
  const parsed = parseEncrypted(value, field);
  return openWith(requireKey(current, parsed.id, field), parsed, field);
}

/** Já é texto cifrado por uma chave carregada e íntegro: gravar de novo não cifra duas vezes. */
const isOwnCiphertext = (current: EncryptionState, value: unknown): boolean => {
  if (!isEncryptedValue(value)) return false;
  try {
    const parsed = parseEncrypted(value);
    openWith(requireKey(current, parsed.id), parsed);
    return true;
  } catch {
    return false;
  }
};

const seal = (key: LoadedKey, value: unknown): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.key, iv);
  const payload = JSON.stringify(value, withBigintAsText);
  const data = Buffer.concat([cipher.update(payload, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}${key.id}:${iv.toString("base64url")}:${data.toString("base64url")}`;
};

/**
 * Cifra o valor com a chave atual. Texto, número, booleano e objeto (JSON) fazem ida e volta;
 * `bigint` volta como texto e `Date` como o ISO. `null`/`undefined` passam intactos. Valor que já
 * é texto cifrado íntegro, de uma chave carregada, é devolvido como está.
 */
export function encryptValue<T>(value: T): T | string {
  if (value == null) return value;
  const current = requireState();
  if (isOwnCiphertext(current, value)) return value as T;
  return seal(current.current, value);
}

/** Quantos valores há em cada chave: `plain` (texto puro), `empty` (nulo), rótulo ou id da chave. */
export function countByEncryptionKey(values: Iterable<unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const bucket = bucketOf(value);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

const idOf = (value: string): string => value.slice(PREFIX.length).split(":")[0] ?? "";

const bucketOf = (value: unknown): string => {
  if (value == null) return "empty";
  if (!isEncryptedValue(value)) return "plain";
  const id = idOf(value);
  return state?.byId.get(id)?.label ?? id;
};

export interface ReencryptColumnOptions {
  /**
   * Lê um lote da coluna, CRU (sem decifrar), em ordem de id: as linhas depois de `after`
   * (`undefined` no primeiro lote), no máximo `limit`.
   */
  read: (after: unknown, limit: number) => Promise<ReadonlyArray<{ id: unknown; value: unknown }>>;
  /** Grava o valor recifrado na linha. */
  write: (id: unknown, value: string) => Promise<void>;
  /** Linhas por lote. Default: `500`. */
  batchSize?: number;
  /** Só conta, sem gravar nada. Default: `false`. */
  dryRun?: boolean;
}

export interface ReencryptReport {
  /** Linhas lidas. */
  read: number;
  /** Valores recifrados com a chave atual. */
  rewritten: number;
  /** Quantos valores havia em cada chave antes (`plain`, `empty`, rótulo ou id da chave). */
  before: Record<string, number>;
  /**
   * Quantos ficaram em cada chave. A chave antiga só pode sair da configuração quando ela não
   * aparece mais aqui.
   */
  after: Record<string, number>;
}

/** Precisa recifrar: texto puro ou chave carregada que não é a atual. Chave desconhecida, não. */
const needsRewrite = (current: EncryptionState, value: unknown): boolean => {
  if (value == null) return false;
  if (!isEncryptedValue(value)) return true;
  const key = current.byId.get(idOf(value));
  return !!key && key !== current.current;
};

const increment = (counts: Record<string, number>, bucket: string) => {
  counts[bucket] = (counts[bucket] ?? 0) + 1;
};

async function rewriteRow(
  current: EncryptionState,
  options: ReencryptColumnOptions,
  report: ReencryptReport,
  row: { id: unknown; value: unknown },
): Promise<void> {
  report.read++;
  increment(report.before, bucketOf(row.value));
  if (options.dryRun || !needsRewrite(current, row.value)) {
    increment(report.after, bucketOf(row.value));
    return;
  }
  await options.write(row.id, seal(current.current, decryptValue(row.value)));
  report.rewritten++;
  increment(report.after, current.current.label);
}

async function rewriteBatches(
  current: EncryptionState,
  options: ReencryptColumnOptions,
  report: ReencryptReport,
  after: unknown,
): Promise<ReencryptReport> {
  const batchSize = options.batchSize ?? 500;
  const batch = await options.read(after, batchSize);
  for (const row of batch) await rewriteRow(current, options, report, row);
  if (batch.length < batchSize) return report;
  return rewriteBatches(current, options, report, batch[batch.length - 1]!.id);
}

/**
 * Recifra uma coluna em lote com a chave atual: texto puro (dado legado) e valores de chaves
 * antigas. Valor de chave desconhecida fica como está e aparece no relatório pelo id. Com
 * `dryRun`, só conta. Rode até o `after` não ter mais a chave antiga, e só então tire a chave
 * antiga da configuração.
 */
export function reencryptColumn(options: ReencryptColumnOptions): Promise<ReencryptReport> {
  const current = requireState();
  const report: ReencryptReport = { read: 0, rewritten: 0, before: {}, after: {} };
  return rewriteBatches(current, options, report, undefined);
}

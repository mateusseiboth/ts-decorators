/**
 * O que o `@Field({ encrypted, normalize })` faz no caminho único de gravação e leitura
 * (`encodeRowForCollection` e `decodeRowsForCollection`, que o `readRows`, o `executeOrmQuery`,
 * o `executePrismaQuery` e o `updateById` usam), no Prisma 7 e no 8.
 *
 * A coleção do Prisma 8 e o delegate do Prisma 7 só dizem o NOME do model do Prisma; o model do
 * pacote (a classe com `@Field`) é achado por ele: `static prismaModel` da classe ou, sem ele, o
 * nome da classe sem o sufixo `Model` (`CertificadoModel` → `Certificado`).
 */
import {
  getFieldOptions,
  getRegisteredModelClasses,
  type FieldOptions,
} from "../decorators/initFields";
import { metadataVersion } from "../decorators/metadata";
import { getNestedModels, type NestedModelMeta } from "../decorators/nestedModel";
import { peekPrismaClient } from "../handlers/prisma";
import { EncryptionError, decryptValue, encryptValue } from "./encryption";
import { normalizeValue } from "./normalize";

type Row = Record<string, unknown>;

/** Opções por coluna de um model do Prisma. */
export type ColumnOptions = Readonly<Record<string, FieldOptions>>;

interface PrismaModelEntry {
  options: ColumnOptions;
  nested: Readonly<Record<string, NestedModelMeta>>;
}

interface Registry {
  version: number;
  byName: Map<string, PrismaModelEntry>;
  encryptedNames: ReadonlySet<string>;
}

let registry: Registry | undefined;

// O `static prismaModel` vale só para a classe que o declara: a subclasse é outro model.
const prismaNameOf = (model: Function): string => {
  const declared = Object.hasOwn(model, "prismaModel")
    ? (model as { prismaModel?: unknown }).prismaModel
    : undefined;
  return typeof declared === "string" ? declared : model.name.replace(/Model$/, "");
};

const mergeEntry = (entry: PrismaModelEntry | undefined, model: Function): PrismaModelEntry => ({
  options: { ...entry?.options, ...getFieldOptions(model.prototype) },
  nested: { ...entry?.nested, ...getNestedModels(model.prototype) },
});

function buildRegistry(): Registry {
  const byName = new Map<string, PrismaModelEntry>();
  const encryptedNames = new Set<string>();
  for (const model of getRegisteredModelClasses()) {
    const name = prismaNameOf(model);
    const entry = mergeEntry(byName.get(name), model);
    byName.set(name, entry);
    for (const [field, options] of Object.entries(entry.options)) {
      if (options.encrypted) encryptedNames.add(field);
    }
  }
  return { version: metadataVersion(), byName, encryptedNames };
}

const currentRegistry = (): Registry => {
  if (registry?.version !== metadataVersion()) registry = buildRegistry();
  return registry;
};

const findP7ModelName = (fields: Record<string, { modelName?: unknown } | undefined>) =>
  Object.values(fields).find((field) => typeof field?.modelName === "string")?.modelName as
    | string
    | undefined;

/**
 * Nome do model do Prisma: `modelName` da coleção do Prisma 8, ou o `modelName` de qualquer campo
 * de `delegate.fields` no Prisma 7.
 */
export function prismaModelNameOf(target: unknown): string | undefined {
  const candidate = target as { modelName?: unknown; fields?: Record<string, any> } | null;
  if (typeof candidate?.modelName === "string") return candidate.modelName;
  if (!candidate?.fields || typeof candidate.fields !== "object") return undefined;
  return findP7ModelName(candidate.fields);
}

/** As opções das colunas do model do Prisma, ou `undefined` quando nenhuma coluna tem opção. */
export function columnOptionsFor(prismaModel: string | undefined): ColumnOptions | undefined {
  if (!prismaModel) return undefined;
  const options = currentRegistry().byName.get(prismaModel)?.options;
  return options && Object.keys(options).length ? options : undefined;
}

/** O nome é de um campo cifrado em algum model registrado (para mascarar no log). */
export function isEncryptedFieldName(name: string): boolean {
  return currentRegistry().encryptedNames.has(name);
}

/** Gravação: normaliza e, se for o caso, cifra. Campo sem opção passa como veio. */
export function encodeFieldValue(options: FieldOptions | undefined, value: unknown): unknown {
  if (!options) return value;
  const normalized = normalizeValue(value, options.normalize);
  return options.encrypted ? encryptValue(normalized) : normalized;
}

/** Leitura: decifra o campo cifrado. Campo sem cifra passa como veio. */
export function decodeFieldValue(
  options: FieldOptions | undefined,
  field: string,
  value: unknown,
): unknown {
  return options?.encrypted ? decryptValue(value, field) : value;
}

const hasWork = (entry: PrismaModelEntry): boolean =>
  Object.keys(entry.options).length > 0 || Object.keys(entry.nested).length > 0;

const isPlainRow = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !(value instanceof Date);

function decodeEntryRow(entry: PrismaModelEntry, row: Row): Row {
  const out: Row = { ...row };
  for (const [field, value] of Object.entries(row)) {
    const nested = entry.nested[field];
    out[field] = nested
      ? decodeTreeByModel(prismaNameOf(nested.model), value)
      : decodeFieldValue(entry.options[field], field, value);
  }
  return out;
}

/**
 * Leitura sem contrato (Prisma 7): decifra a linha pelo model registrado e desce pelas relações
 * declaradas com `@Field(Model)` / `@Field([Model])`.
 */
export function decodeTreeByModel(prismaModel: string | undefined, rows: unknown): unknown {
  if (Array.isArray(rows)) return rows.map((row) => decodeTreeByModel(prismaModel, row));
  const entry = prismaModel ? currentRegistry().byName.get(prismaModel) : undefined;
  if (!entry || !isPlainRow(rows) || !hasWork(entry)) return rows;
  return decodeEntryRow(entry, rows);
}

// ── Conferência: toda classe cifrada casa com um model do Prisma ──────────────────────────────

/**
 * Marca do contrato PARCIAL (os fakes de `/testing` só declaram os models do teste): nele a
 * conferência não roda.
 */
export const PARTIAL_CONTRACT = Symbol.for("@mateusseiboth/ts-decorators/partial-contract");

/** Uma classe com campo cifrado e o nome de model do Prisma que ela procura. */
export interface UnmappedModel {
  model: string;
  prismaModel: string;
}

const hasEncryptedField = (model: Function): boolean =>
  Object.values(getFieldOptions(model.prototype)).some((options) => options.encrypted === true);

/** Classe base com subclasse registrada é abstrata: quem casa com o model é a subclasse. */
const hasSubclass = (model: Function, classes: readonly Function[]): boolean =>
  classes.some((other) => other !== model && model.prototype.isPrototypeOf(other.prototype));

/** As classes com campo cifrado cujo model não está em `knownModels`. */
export function findUnmappedModels(knownModels: ReadonlySet<string>): UnmappedModel[] {
  const classes = [...getRegisteredModelClasses()];
  return classes
    .filter((model) => hasEncryptedField(model) && !hasSubclass(model, classes))
    .map((model) => ({ model: model.name, prismaModel: prismaNameOf(model) }))
    .filter((item) => !knownModels.has(item.prismaModel));
}

/**
 * Confere que toda classe registrada com campo `encrypted` casa com um dos models do Prisma.
 * Sem isso, a classe de nome errado gravaria em texto puro sem erro. O pacote já confere sozinho
 * no primeiro uso quando conhece os models (contrato do Prisma 8, client do Prisma 7 registrado
 * no `setPrismaClient`); no boot do Prisma 7, chame com `Object.values(Prisma.ModelName)`.
 */
export function checkEncryptedModels(modelNames: Iterable<string>): void {
  const unmapped = findUnmappedModels(new Set(modelNames));
  if (!unmapped.length) return;
  const lista = unmapped.map((item) => `${item.model} procura "${item.prismaModel}"`).join("; ");
  throw new EncryptionError(
    "UNMAPPED_MODEL",
    `[@mateusseiboth/ts-decorators] Classe com campo cifrado sem model no Prisma: ${lista}. Declare static prismaModel com o nome do model no schema.`,
  );
}

// Fonte dos models (contrato ou client) → versão da metadata já conferida.
const checkedSources = new WeakMap<object, number>();

function checkSource(source: object, readNames: () => Iterable<string>): void {
  if (checkedSources.get(source) === metadataVersion()) return;
  checkEncryptedModels(readNames());
  checkedSources.set(source, metadataVersion());
}

interface ContractWithModels {
  [PARTIAL_CONTRACT]?: boolean;
  domain?: { namespaces?: Record<string, { models?: Record<string, unknown> }> };
}

const contractModelNames = (contract: ContractWithModels): string[] =>
  Object.values(contract.domain?.namespaces ?? {}).flatMap((namespace) =>
    Object.keys(namespace.models ?? {}),
  );

interface Prisma7ClientWithModels {
  _runtimeDataModel?: { models?: Record<string, unknown> };
}

function checkPrisma7Client(): void {
  const client = peekPrismaClient() as Prisma7ClientWithModels | null;
  const models = client?._runtimeDataModel?.models;
  if (!client || !models) return;
  checkSource(client, () => Object.keys(models));
}

/**
 * A conferência automática do caminho de gravação e leitura: pelo contrato da coleção do
 * Prisma 8, ou, com o delegate do Prisma 7, pelos models do client registrado. Roda uma vez por
 * contrato (ou client) e versão da metadata; falha com `EncryptionError` `UNMAPPED_MODEL`.
 */
export function requireMappedModels(target: unknown): void {
  const contract = (target as { contract?: ContractWithModels } | null)?.contract;
  if (contract) {
    if (contract[PARTIAL_CONTRACT]) return;
    checkSource(contract, () => contractModelNames(contract));
    return;
  }
  if (prismaModelNameOf(target)) checkPrisma7Client();
}

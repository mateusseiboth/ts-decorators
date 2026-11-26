import "reflect-metadata";
import { logger } from "../functions/logger";
import { isDecoratorContext } from "./_proxy";
import { bumpMetadataVersion, createMetadataCache, freezeIfEnabled } from "./metadata";

/** Metadados de um campo aninhado (relação para outro Model). */
export interface NestedModelMeta {
  /** Classe do model aninhado. */
  model: Function;
  /** `true` quando o campo é uma lista (ex.: `posts: PostModel[]`). */
  isArray: boolean;
  /**
   * `true` quando o @AutoConvert deve instanciar/converter o valor aninhado.
   *
   * Apenas relações declaradas via `@Field(Model)` / `@Field([Model])` ativam
   * isso. O `@NestedModel` mantém o comportamento histórico (somente
   * descoberta de campos para o getWhere, sem instanciar nada no AutoConvert).
   */
  autoConvert: boolean;
}

const NESTED_MODELS = new WeakMap<object, Record<string, NestedModelMeta>>();

/**
 * Relações já achatadas por alvo. Sem isso, cada campo convertido pelo
 * @AutoConvert refazia a caminhada na cadeia de protótipos.
 */
const NESTED_CACHE = createMetadataCache<object, Readonly<Record<string, NestedModelMeta>>>();

/**
 * Normaliza uma entrada do registro para o formato {@link NestedModelMeta}.
 *
 * Aceita tanto o formato antigo (apenas a classe) — caso algum metadado
 * legado/externo ainda exista — quanto o novo (`{model, isArray}`),
 * garantindo retrocompatibilidade total.
 */
function normalizeNestedEntry(entry: any): NestedModelMeta | undefined {
  if (!entry) return undefined;
  // Formato antigo: apenas a classe (sempre to-one, sem auto-conversão).
  if (typeof entry === "function") return { model: entry, isArray: false, autoConvert: false };
  if (typeof entry === "object" && typeof entry.model === "function") {
    return { model: entry.model, isArray: !!entry.isArray, autoConvert: !!entry.autoConvert };
  }
  return undefined;
}

/**
 * Registra um model aninhado no armazenamento legacy (WeakMap por prototype).
 * Usado tanto pelo @NestedModel quanto pelo @Field(Class) / @Field([Class]).
 */
export function registerNestedModelLegacy(
  target: object,
  key: string,
  model: Function,
  isArray = false,
  autoConvert = false,
): void {
  let nested = NESTED_MODELS.get(target);
  if (!nested) {
    nested = {};
    NESTED_MODELS.set(target, nested);
  }
  nested[key] = { model, isArray, autoConvert };
  bumpMetadataVersion();
}

/**
 * Registra um model aninhado no metadata TC39 (Symbol.metadata).
 */
export function registerNestedModelMeta(
  meta: Record<string, any>,
  key: string,
  model: Function,
  isArray = false,
  autoConvert = false,
): void {
  if (!meta.__nested) meta.__nested = {};
  meta.__nested[key] = { model, isArray, autoConvert };
  bumpMetadataVersion();
}

/**
 * @NestedModel - Decorator de propriedade/campo.
 * Suporta legacy e TC39 Stage 3.
 *
 * Marca um campo como relação para outro Model (sempre to-one).
 * Para listas/arrays, prefira `@Field([OutroModel])`.
 */
export function NestedModel(modelClass: Function) {
  logger.debug(`[@mateusseiboth/ts-decorators] Registering nested model:`, modelClass.name);
  return function (...args: any[]): any {
    // New TC39 field decorator: (value, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "field") {
      const context = args[1] as ClassFieldDecoratorContext;
      const fieldName = String(context.name);
      const meta = context.metadata as Record<string, any>;
      registerNestedModelMeta(meta, fieldName, modelClass, false);
      return;
    }

    // Legacy property decorator: (target, propertyKey)
    const [target, propertyKey] = args;
    registerNestedModelLegacy(target, propertyKey as string, modelClass, false);
  };
}

/**
 * Retorna a classe do model aninhado para `key`, ou `undefined`.
 * Mantido para retrocompatibilidade (retorna apenas a classe).
 */
export function getNestedModel(target: any, key: string): any | undefined {
  return getNestedModelMeta(target, key)?.model;
}

/**
 * Retorna os metadados completos ({model, isArray, autoConvert}) do campo aninhado `key`,
 * ou `undefined` se o campo não for uma relação.
 */
/**
 * Achata todas as relações visíveis a partir de `target` (próprias + herdadas).
 * O mais PRÓXIMO na cadeia vence, mesma precedência da busca original.
 */
function resolveNestedModels(target: any): Readonly<Record<string, NestedModelMeta>> {
  const result: Record<string, NestedModelMeta> = {};

  // New TC39 primeiro: o legacy (mais próximo na cadeia) sobrescreve depois.
  const ctor = typeof target === "function" ? target : target?.constructor;
  if (ctor && typeof Symbol !== "undefined" && Symbol.metadata) {
    const meta = ctor[Symbol.metadata] as Record<string, any> | undefined;
    for (const [key, entry] of Object.entries(meta?.__nested ?? {})) {
      const normalized = normalizeNestedEntry(entry);
      if (normalized) result[key] = normalized;
    }
  }

  // Legacy: da superclasse para a subclasse, para o mais próximo prevalecer.
  const chain: object[] = [];
  let proto = target;
  while (proto && proto !== Object.prototype) {
    chain.push(proto);
    proto = Object.getPrototypeOf(proto);
  }
  for (const link of chain.reverse()) {
    for (const [key, entry] of Object.entries(NESTED_MODELS.get(link) ?? {})) {
      const normalized = normalizeNestedEntry(entry);
      if (normalized) result[key] = normalized;
    }
  }

  // COMPARTILHADO entre todas as leituras — trate como somente leitura.
  return freezeIfEnabled(result);
}

/** Todas as relações de um model, achatadas e memorizadas. Somente leitura. */
export function getNestedModels(target: any): Readonly<Record<string, NestedModelMeta>> {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return EMPTY_NESTED;
  return NESTED_CACHE.get(target as object, resolveNestedModels);
}

export function getNestedModelMeta(target: any, key: string): NestedModelMeta | undefined {
  const nested = getNestedModels(target);
  return Object.hasOwn(nested, key) ? nested[key] : undefined;
}

const EMPTY_NESTED: Readonly<Record<string, NestedModelMeta>> = Object.freeze({});

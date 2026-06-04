import "reflect-metadata";
import {isDecoratorContext, warnLegacy} from "./_proxy";

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
 * Normaliza uma entrada do registro para o formato {@link NestedModelMeta}.
 *
 * Aceita tanto o formato antigo (apenas a classe) — caso algum metadado
 * legado/externo ainda exista — quanto o novo (`{model, isArray}`),
 * garantindo retrocompatibilidade total.
 */
function normalizeNestedEntry(entry: any): NestedModelMeta | undefined {
  if (!entry) return undefined;
  // Formato antigo: apenas a classe (sempre to-one, sem auto-conversão).
  if (typeof entry === "function") return {model: entry, isArray: false, autoConvert: false};
  if (typeof entry === "object" && typeof entry.model === "function") {
    return {model: entry.model, isArray: !!entry.isArray, autoConvert: !!entry.autoConvert};
  }
  return undefined;
}

/**
 * Registra um model aninhado no armazenamento legacy (WeakMap por prototype).
 * Usado tanto pelo @NestedModel quanto pelo @Field(Class) / @Field([Class]).
 */
export function registerNestedModelLegacy(target: object, key: string, model: Function, isArray = false, autoConvert = false): void {
  let nested = NESTED_MODELS.get(target);
  if (!nested) {
    nested = {};
    NESTED_MODELS.set(target, nested);
  }
  nested[key] = {model, isArray, autoConvert};
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
  meta.__nested[key] = {model, isArray, autoConvert};
}

/**
 * @NestedModel - Decorator de propriedade/campo.
 * Suporta legacy e TC39 Stage 3.
 *
 * Marca um campo como relação para outro Model (sempre to-one).
 * Para listas/arrays, prefira `@Field([OutroModel])`.
 */
export function NestedModel(modelClass: Function) {
  console.log(`[@mateusseiboth/ts-commons] Registering nested model:`, modelClass.name);
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
    warnLegacy("NestedModel");
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
 * Retorna os metadados completos ({model, isArray}) do campo aninhado `key`,
 * ou `undefined` se o campo não for uma relação.
 */
export function getNestedModelMeta(target: any, key: string): NestedModelMeta | undefined {
  // Legacy: walk prototype chain
  let proto = target;
  while (proto && proto !== Object.prototype) {
    const nested = NESTED_MODELS.get(proto);
    if (nested && nested[key]) return normalizeNestedEntry(nested[key]);
    proto = Object.getPrototypeOf(proto);
  }

  // New TC39: check Symbol.metadata
  const ctor = typeof target === "function" ? target : target?.constructor;
  if (ctor && typeof Symbol !== "undefined" && Symbol.metadata) {
    const meta = ctor[Symbol.metadata] as Record<string, any> | undefined;
    if (meta?.__nested && meta.__nested[key]) {
      return normalizeNestedEntry(meta.__nested[key]);
    }
  }

  return undefined;
}

import "reflect-metadata";
import { logger } from "../functions/logger";
import { isDecoratorContext, warnLegacy } from "./_proxy";
import { bumpMetadataVersion, createMetadataCache } from "./metadata";
import { registerNestedModelLegacy, registerNestedModelMeta } from "./nestedModel";

const CLASS_FIELDS = new WeakMap<object, Record<string, string>>();

/**
 * Mapa de tipos já achatado por alvo (prototype/instância). Resolver percorre a
 * cadeia de protótipos + `Symbol.metadata`; sem cache isso acontecia a cada
 * requisição e a cada campo convertido.
 */
const FIELD_TYPES_CACHE = createMetadataCache<object, Readonly<Record<string, string>>>();

/** Tipo aceito pelo @Field. */
export type FieldType = string | Function | [Function];

/**
 * Interpreta o argumento de @Field e separa a parte de "tipo primitivo"
 * (string guardada em CLASS_FIELDS) da parte de "model aninhado".
 *
 * - `@Field('number')`        → {typeString: 'number'}
 * - `@Field(PostModel)`       → {typeString: 'object', nested: {model, isArray:false}}
 * - `@Field([PostModel])`     → {typeString: 'object', nested: {model, isArray:true}}
 * - `@Field()`                → {typeString: undefined} (deixa o reflect/any decidir)
 */
function resolveFieldType(type: FieldType | undefined): {
  typeString?: string;
  nested?: { model: Function; isArray: boolean };
} {
  if (typeof type === "function") {
    return { typeString: "object", nested: { model: type, isArray: false } };
  }
  if (Array.isArray(type)) {
    const model = type[0];
    if (typeof model === "function") {
      return { typeString: "object", nested: { model, isArray: true } };
    }
    return { typeString: "object" };
  }
  if (typeof type === "string") {
    return { typeString: type };
  }
  return {};
}

/**
 * @Field - Decorator de propriedade/campo.
 * Suporta legacy e TC39 Stage 3.
 *
 * Legacy: @Field() - tipo detectado via reflect-metadata
 * Novo:   @Field('number') - tipo passado explicitamente
 *
 * Models aninhados (relações):
 *   @Field(PostModel)   - objeto único de outro Model
 *   @Field([PostModel]) - lista de outro Model
 * Nesses casos o @AutoConvert instancia/converte o objeto/array aninhado
 * recursivamente, e o collectFieldTypes expõe os campos (to-one) para o getWhere.
 */
export function Field(type?: FieldType) {
  const { typeString, nested } = resolveFieldType(type);

  return function (...args: any[]): any {
    // New TC39 field decorator: (value, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "field") {
      const context = args[1] as ClassFieldDecoratorContext;
      const fieldName = String(context.name);
      const meta = context.metadata as Record<string, any>;
      if (!meta.__fields) meta.__fields = {};
      meta.__fields[fieldName] = typeString || "any";
      if (nested) registerNestedModelMeta(meta, fieldName, nested.model, nested.isArray, true);
      bumpMetadataVersion();
      return;
    }

    // Legacy property decorator: (target, propertyKey)
    warnLegacy("Field");
    const [target, propertyKey] = args;
    let fields = CLASS_FIELDS.get(target);
    if (!fields) {
      fields = {};
      CLASS_FIELDS.set(target, fields);
    }
    if (nested) {
      fields[propertyKey as string] = typeString || "object";
      registerNestedModelLegacy(target, propertyKey as string, nested.model, nested.isArray, true);
    } else if (typeString) {
      fields[propertyKey as string] = typeString;
    } else {
      const reflectedType = Reflect.getMetadata("design:type", target, propertyKey);
      fields[propertyKey as string] = reflectedType?.name.toLowerCase() || "any";
    }
    bumpMetadataVersion();
  };
}

/**
 * @InitFields - Decorator de classe.
 * Suporta legacy e TC39 Stage 3.
 */
export function InitFields<T extends { new (...args: any[]): {} }>(
  constructor: T,
  context?: ClassDecoratorContext,
): T {
  if (context && isDecoratorContext(context)) {
    // New TC39: sincroniza metadata para WeakMap
    const meta = context.metadata as Record<string, any>;
    if (meta?.__fields) {
      const proto = constructor.prototype;
      let fields = CLASS_FIELDS.get(proto);
      if (!fields) {
        fields = {};
        CLASS_FIELDS.set(proto, fields);
      }
      Object.assign(fields, meta.__fields);
    }
  } else {
    warnLegacy("InitFields");
  }
  const proto = constructor.prototype;
  logger.debug("[@mateusseiboth/ts-commons] Initializing fields for", constructor.name);
  if (!CLASS_FIELDS.has(proto)) CLASS_FIELDS.set(proto, {});
  bumpMetadataVersion();
  return constructor;
}

function resolveFieldTypes(target: any): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};

  // Legacy: walk prototype chain in WeakMap
  let proto = target;
  while (proto && proto !== Object.prototype) {
    const fields = CLASS_FIELDS.get(proto);
    if (fields) Object.assign(result, fields);
    proto = Object.getPrototypeOf(proto);
  }

  // New TC39: check Symbol.metadata
  const ctor = typeof target === "function" ? target : target?.constructor;
  if (ctor && typeof Symbol !== "undefined" && Symbol.metadata) {
    const meta = ctor[Symbol.metadata] as Record<string, any> | undefined;
    if (meta?.__fields) {
      Object.assign(result, meta.__fields);
    }
  }

  // Congelado de propósito: o mapa é COMPARTILHADO entre todas as leituras.
  return Object.freeze(result);
}

/**
 * Tipos de campo achatados do model, incluindo os herdados.
 *
 * O resultado é memorizado por alvo e CONGELADO — trate como somente leitura.
 */
export function getFieldTypes(target: any): Record<string, string> {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return {};
  return FIELD_TYPES_CACHE.get(target as object, resolveFieldTypes);
}

export function getFieldTypeByKey(instance: any, key: string): string | undefined {
  const proto = instance != null ? Object.getPrototypeOf(instance) : null;
  if (!proto) return undefined;
  const types = getFieldTypes(proto);
  return Object.hasOwn(types, key) ? types[key] : undefined;
}

export { clearMetadataCache } from "./metadata";

import "reflect-metadata";
import type { FieldNormalize } from "../fields/normalize";
import { logger } from "../functions/logger";
import {
  temporalTypeName,
  type TemporalConstructor,
  type TemporalFieldType,
} from "../functions/parseTemporal";
import { isDecoratorContext, warnLegacy } from "./_proxy";
import { bumpMetadataVersion, createMetadataCache, freezeIfEnabled } from "./metadata";
import { registerNestedModelLegacy, registerNestedModelMeta } from "./nestedModel";

const CLASS_FIELDS = new WeakMap<object, Record<string, string>>();
const CLASS_FIELD_OPTIONS = new WeakMap<object, Record<string, FieldOptions>>();

/**
 * Toda classe de model registrada (`@InitFields`, ou `@Field` com opções no modo legado). É por
 * aqui que o caminho de gravação e leitura acha o model do Prisma pelo nome.
 */
const MODEL_CLASSES = new Set<Function>();

/**
 * Mapa de tipos já achatado por alvo (prototype/instância). Resolver percorre a
 * cadeia de protótipos + `Symbol.metadata`; sem cache isso acontecia a cada
 * requisição e a cada campo convertido.
 */
const FIELD_TYPES_CACHE = createMetadataCache<object, Readonly<Record<string, string>>>();

/** Tipos primitivos convertidos pelo @AutoConvert. */
export type PrimitiveFieldType = "string" | "number" | "bigint" | "boolean" | "date";

/**
 * Nome de tipo aceito pelo @Field. Os literais são só para autocompletar —
 * `string` continua valendo para tipo livre (o @AutoConvert deixa o valor como veio).
 */
export type FieldTypeName =
  | PrimitiveFieldType
  | TemporalFieldType
  | "object"
  | "any"
  | (string & {});

/**
 * Model aninhado (relação): `@Field(PostModel)` para to-one, `@Field([PostModel])`
 * para to-many. É `Function` de propósito — qualquer classe de model serve, com
 * ou sem construtor público.
 */
export type NestedModelType = Function;

/**
 * Tipo aceito pelo @Field:
 * - nome do tipo (`"number"`, `"zoneddatetime"`, `"Temporal.PlainDate"`…)
 * - construtor do Temporal (`Temporal.ZonedDateTime`)
 * - model aninhado (`PostModel`) ou lista de model (`[PostModel]`)
 */
export type FieldType = FieldTypeName | TemporalConstructor | NestedModelType | [NestedModelType];

/**
 * Opções do `@Field`, no lugar do tipo: `@Field({ type: "string", encrypted: true })`.
 */
export interface FieldOptions {
  /** O mesmo argumento do `@Field(type)`. */
  type?: FieldType;
  /**
   * Cifra o valor na gravação e decifra na leitura (AES-256-GCM), com as chaves do
   * `configureEncryption`. O campo deixa de servir para filtro, ordenação e índice.
   */
  encrypted?: boolean;
  /** Normaliza o texto na gravação e no filtro do `getWhere` (`"digits"`, `"trim"`, `"upper"`). */
  normalize?: FieldNormalize;
}

const isFieldOptions = (value: unknown): value is FieldOptions =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasFieldBehavior = (options: FieldOptions | undefined): options is FieldOptions =>
  !!options && (options.encrypted === true || options.normalize !== undefined);

/**
 * Interpreta o argumento de @Field e separa a parte de "tipo primitivo"
 * (string guardada em CLASS_FIELDS) da parte de "model aninhado".
 *
 * - `@Field('number')`        → {typeString: 'number'}
 * - `@Field(Temporal.PlainDate)` → {typeString: 'plaindate'} (não é model aninhado)
 * - `@Field('zoneddatetime')` → {typeString: 'zoneddatetime'} (mesma coisa, por nome)
 * - `@Field(PostModel)`       → {typeString: 'object', nested: {model, isArray:false}}
 * - `@Field([PostModel])`     → {typeString: 'object', nested: {model, isArray:true}}
 * - `@Field()`                → {typeString: undefined} (deixa o reflect/any decidir)
 */
function resolveFieldType(type: FieldType | undefined): {
  typeString?: string;
  nested?: { model: Function; isArray: boolean };
} {
  if (typeof type === "function") {
    const temporal = temporalTypeName(type);
    if (temporal) return { typeString: temporal };
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
export function Field(typeOrOptions?: FieldType | FieldOptions) {
  const options = isFieldOptions(typeOrOptions) ? { ...typeOrOptions } : undefined;
  const type = options ? options.type : (typeOrOptions as FieldType | undefined);
  const { typeString, nested } = resolveFieldType(type);

  return function (...args: any[]): any {
    // New TC39 field decorator: (value, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "field") {
      const context = args[1] as ClassFieldDecoratorContext;
      const fieldName = String(context.name);
      const meta = context.metadata as Record<string, any>;
      if (!meta.__fields) meta.__fields = {};
      meta.__fields[fieldName] = typeString || "any";
      if (hasFieldBehavior(options)) {
        // O metadata da subclasse herda o da base por protótipo: copiar antes de gravar, senão o
        // campo da subclasse entraria na base.
        meta.__fieldOptions = { ...meta.__fieldOptions, [fieldName]: options };
      }
      if (nested) registerNestedModelMeta(meta, fieldName, nested.model, nested.isArray, true);
      bumpMetadataVersion();
      return;
    }

    // Legacy property decorator: (target, propertyKey)
    warnLegacy("Field");
    const [target, propertyKey] = args;
    saveLegacyFieldOptions(target, propertyKey as string, options);
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

function saveLegacyFieldOptions(target: any, key: string, options: FieldOptions | undefined) {
  if (!hasFieldBehavior(options)) return;
  const saved = CLASS_FIELD_OPTIONS.get(target) ?? {};
  saved[key] = options;
  CLASS_FIELD_OPTIONS.set(target, saved);
  if (typeof target?.constructor === "function") MODEL_CLASSES.add(target.constructor);
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
    if (meta?.__fieldOptions) {
      const proto = constructor.prototype;
      CLASS_FIELD_OPTIONS.set(proto, {
        ...CLASS_FIELD_OPTIONS.get(proto),
        ...meta.__fieldOptions,
      });
    }
  } else {
    warnLegacy("InitFields");
  }
  const proto = constructor.prototype;
  logger.debug("[@mateusseiboth/ts-decorators] Initializing fields for", constructor.name);
  if (!CLASS_FIELDS.has(proto)) CLASS_FIELDS.set(proto, {});
  MODEL_CLASSES.add(constructor);
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

  // COMPARTILHADO entre todas as leituras — trate como somente leitura.
  return freezeIfEnabled(result);
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

const FIELD_OPTIONS_CACHE = createMetadataCache<object, Readonly<Record<string, FieldOptions>>>();

function resolveFieldOptions(target: any): Readonly<Record<string, FieldOptions>> {
  const result: Record<string, FieldOptions> = {};
  const chain: object[] = [];
  for (
    let proto = target;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    chain.unshift(proto);
  }
  // Da base para a subclasse: o campo redeclarado na subclasse vence.
  for (const proto of chain) Object.assign(result, CLASS_FIELD_OPTIONS.get(proto));

  const ctor = typeof target === "function" ? target : target?.constructor;
  const meta = Symbol.metadata
    ? (ctor?.[Symbol.metadata] as Record<string, any> | undefined)
    : undefined;
  Object.assign(result, meta?.__fieldOptions);

  return freezeIfEnabled(result);
}

/**
 * As opções (`encrypted`, `normalize`) dos campos declarados com `@Field({ ... })`, incluindo os
 * herdados. Campo sem opção fica de fora. Memorizado por alvo: trate como somente leitura.
 */
export function getFieldOptions(target: any): Record<string, FieldOptions> {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return {};
  return FIELD_OPTIONS_CACHE.get(target as object, resolveFieldOptions);
}

/** As classes de model registradas. Uso interno do caminho de gravação e leitura. */
export function getRegisteredModelClasses(): ReadonlySet<Function> {
  return MODEL_CLASSES;
}

export { clearMetadataCache } from "./metadata";

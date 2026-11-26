/**
 * @MaskSensitive — marca campos sensíveis e mascara seus valores em logs/respostas.
 *
 * Dois usos:
 *  1. Em PROPRIEDADE: marca o campo como sensível.
 *       @MaskSensitive() password!: string;
 *       @MaskSensitive({ visible: 4 }) cpf!: string;  // mantém os 4 últimos
 *  2. Em MÉTODO: mascara, no objeto retornado, os campos marcados na classe.
 *       @MaskSensitive()
 *       async getById(req, res) { ... }   // resposta com campos mascarados
 *
 * `applyMask(obj, ClasseOuMeta)` também pode ser usado diretamente (ex.: ao logar).
 */

import "reflect-metadata";
import { appendMetadataItem } from "./_metadataList";
import { makeMethodDecorator } from "./_method";
import { isDecoratorContext } from "./_proxy";
import { getFieldOptions } from "./initFields";
import { bumpMetadataVersion, createMetadataCache } from "./metadata";

const MASK_FIELDS_KEY = "mask:fields";

export interface MaskOptions {
  /** Caractere usado na máscara. Default: "*". */
  maskChar?: string;
  /** Quantos caracteres finais permanecem visíveis. Default: 0. */
  visible?: number;
}

interface FieldMeta extends Required<MaskOptions> {
  field: string;
}

const DEFAULTS: Required<MaskOptions> = { maskChar: "*", visible: 0 };

const MASK_CACHE = createMetadataCache<object, readonly FieldMeta[]>();

const NO_FIELDS: readonly FieldMeta[] = Object.freeze([]);

/** Campos marcados na classe, vindos do registro legacy E do metadata TC39. */
function resolveMaskFields(ctor: any): readonly FieldMeta[] {
  const legacy: FieldMeta[] = Reflect.getMetadata(MASK_FIELDS_KEY, ctor) ?? [];
  const tc39: FieldMeta[] =
    (typeof Symbol !== "undefined" && Symbol.metadata
      ? (ctor?.[Symbol.metadata]?.[MASK_FIELDS_KEY] as FieldMeta[] | undefined)
      : undefined) ?? [];

  const marked = [...tc39, ...legacy];
  const encrypted = encryptedFields(ctor, marked);
  if (!marked.length && !encrypted.length) return NO_FIELDS;
  return Object.freeze([...marked, ...encrypted]);
}

/** Campo `@Field({ encrypted: true })` é sensível mesmo sem `@MaskSensitive`. */
function encryptedFields(ctor: any, marked: readonly FieldMeta[]): FieldMeta[] {
  const options = getFieldOptions(ctor?.prototype);
  return Object.keys(options)
    .filter((field) => options[field]?.encrypted && !marked.some((meta) => meta.field === field))
    .map((field) => ({ field, ...DEFAULTS }));
}

/**
 * Lista memorizada dos campos sensíveis da classe. `applyMask` roda por
 * resposta; reler a metadata reflexiva a cada chamada era puro desperdício.
 */
function getMaskFields(ctor: any): readonly FieldMeta[] {
  if (!ctor || (typeof ctor !== "object" && typeof ctor !== "function")) return NO_FIELDS;
  return MASK_CACHE.get(ctor as object, resolveMaskFields);
}

function maskValue(value: unknown, opts: Required<MaskOptions>): unknown {
  if (value === null || value === undefined) return value;
  // Campo mascarado pode ser qualquer coisa; objeto vira "[object Object]" e é
  // mascarado assim mesmo. O cast é só para o lint — `String` já se comporta assim.
  const str = String(value as string);
  if (opts.visible > 0 && str.length > opts.visible) {
    const tail = str.slice(-opts.visible);
    return opts.maskChar.repeat(str.length - opts.visible) + tail;
  }
  return opts.maskChar.repeat(str.length || 1);
}

/** Aplica a máscara nos campos sensíveis de `obj` (não muta o original). */
export function applyMask<T extends Record<string, any>>(obj: T, ctor: any): T {
  if (!obj || typeof obj !== "object") return obj;
  const fields = getMaskFields(ctor);
  if (fields.length === 0) return obj;
  const clone: Record<string, any> = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const meta of fields) {
    if (meta.field in clone) {
      clone[meta.field] = maskValue(clone[meta.field], meta);
    }
  }
  return clone as T;
}

export function MaskSensitive(options?: MaskOptions) {
  const opts = { ...DEFAULTS, ...options };

  return function (...args: any[]): any {
    // TC39 field: (value, context{kind:"field"})
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "field") {
      const context = args[1] as ClassFieldDecoratorContext;
      // No TC39, o metadata da classe fica em context.metadata.
      const meta = (context.metadata[MASK_FIELDS_KEY] as FieldMeta[]) ?? [];
      meta.push({ field: String(context.name), ...opts });
      (context.metadata as any)[MASK_FIELDS_KEY] = meta;
      bumpMetadataVersion();
      return;
    }

    // TC39 method: (method, context{kind:"method"})
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      return makeMethodDecorator("MaskSensitive", (original) => {
        return async function (this: any, ...callArgs: any[]) {
          const result = await original.apply(this, callArgs);
          return applyMask(result, this.constructor);
        };
      })(args[0], args[1]);
    }

    // Legacy property: (target, propertyKey) — descriptor é undefined em propriedade
    if (args.length >= 2 && args[2] === undefined) {
      const target = args[0];
      const propertyKey = args[1] as string;
      appendMetadataItem<FieldMeta>(MASK_FIELDS_KEY, target.constructor, {
        field: propertyKey,
        ...opts,
      });
      bumpMetadataVersion();
      return;
    }

    // Legacy method: (target, propertyKey, descriptor)
    const descriptor = args[2] as PropertyDescriptor;
    const original = descriptor.value;
    descriptor.value = async function (this: any, ...callArgs: any[]) {
      const result = await original.apply(this, callArgs);
      return applyMask(result, this.constructor);
    };
    return descriptor;
  };
}

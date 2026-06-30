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
import {isDecoratorContext, warnLegacy} from "./_proxy";
import {makeMethodDecorator} from "./_method";

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

const DEFAULTS: Required<MaskOptions> = {maskChar: "*", visible: 0};

function getMaskFields(ctor: any): FieldMeta[] {
  return Reflect.getMetadata(MASK_FIELDS_KEY, ctor) ?? [];
}

function maskValue(value: unknown, opts: Required<MaskOptions>): unknown {
  if (value === null || value === undefined) return value;
  const str = String(value);
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
  const clone: Record<string, any> = Array.isArray(obj) ? [...obj] : {...obj};
  for (const meta of fields) {
    if (meta.field in clone) {
      clone[meta.field] = maskValue(clone[meta.field], meta);
    }
  }
  return clone as T;
}

export function MaskSensitive(options?: MaskOptions) {
  const opts = {...DEFAULTS, ...options};

  return function (...args: any[]): any {
    // TC39 field: (value, context{kind:"field"})
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "field") {
      const context = args[1] as ClassFieldDecoratorContext;
      // No TC39, o metadata da classe fica em context.metadata.
      const meta = (context.metadata[MASK_FIELDS_KEY] as FieldMeta[]) ?? [];
      meta.push({field: String(context.name), ...opts});
      (context.metadata as any)[MASK_FIELDS_KEY] = meta;
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
      warnLegacy("MaskSensitive");
      const target = args[0];
      const propertyKey = args[1] as string;
      const list = getMaskFields(target.constructor);
      list.push({field: propertyKey, ...opts});
      Reflect.defineMetadata(MASK_FIELDS_KEY, list, target.constructor);
      return;
    }

    // Legacy method: (target, propertyKey, descriptor)
    warnLegacy("MaskSensitive");
    const descriptor = args[2] as PropertyDescriptor;
    const original = descriptor.value;
    descriptor.value = async function (this: any, ...callArgs: any[]) {
      const result = await original.apply(this, callArgs);
      return applyMask(result, this.constructor);
    };
    return descriptor;
  };
}

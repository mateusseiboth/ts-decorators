import {isDecoratorContext, warnLegacy} from "./_proxy";
import {getFieldTypeByKey, getFieldTypes} from "./initFields";
import {getNestedModelMeta, type NestedModelMeta} from "./nestedModel";

/**
 * Converte um único valor primitivo de acordo com o tipo declarado no @Field.
 * Mantém exatamente a mesma semântica histórica do @AutoConvert.
 */
export function convertPrimitive(type: string | undefined, val: any): any {
  if (val === null || val === undefined) return null;

  switch (type?.toLowerCase()) {
    case "number": {
      const n = Number(val);
      return isNaN(n) ? null : n;
    }

    case "bigint":
      try {
        return BigInt(val);
      } catch {
        return null;
      }

    case "boolean":
      return val === "false" || val === 0 || val === "0" || val === "N"
        ? false
        : val === "true" || val === 1 || val === "1" || val === "S"
          ? true
          : Boolean(val);

    case "date": {
      if (val instanceof Date) return val;
      if (val === 0 || val === "0") return null;
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    }

    case "string":
      return String(val);

    default:
      // mantém original
      return val;
  }
}

/**
 * Instancia (e converte) um único item de um model aninhado.
 *
 * - Se o item já é instância do model, retorna como está.
 * - Caso contrário cria `new Model()` e, se houver `setData` (normalmente
 *   embrulhado por @AutoConvert), delega para ele — o que faz a conversão
 *   recursiva acontecer naturalmente.
 * - Se o model não tiver `setData`, faz um fallback convertendo campo a campo.
 */
function instantiateNested(model: Function, item: any): any {
  if (item === null || item === undefined || typeof item !== "object") return item;
  if (typeof model !== "function") return item;
  if (item instanceof (model as any)) return item;

  let instance: any;
  try {
    instance = new (model as any)();
  } catch {
    // Model não instanciável sem argumentos → não há como converter com segurança.
    return item;
  }

  if (typeof instance.setData === "function") {
    instance.setData(item);
    return instance;
  }

  // Fallback: converte campo a campo (incluindo aninhamento mais profundo).
  const types = getFieldTypes(instance);
  for (const k of Object.keys(item)) {
    if (!(k in types)) continue;
    const childNested = getNestedModelMeta(instance, k);
    if (childNested) {
      instance[k] = convertNestedValue(childNested, item[k]);
    } else {
      instance[k] = convertPrimitive(getFieldTypeByKey(instance, k), item[k]);
    }
  }
  return instance;
}

/**
 * Converte o valor de um campo aninhado, respeitando se é lista ou objeto único.
 */
function convertNestedValue(meta: NestedModelMeta, value: any): any {
  if (value === null || value === undefined) return value;

  if (meta.isArray) {
    if (Array.isArray(value)) return value.map((v) => instantiateNested(meta.model, v));
    // valor único informado para um campo de lista → normaliza para array
    return [instantiateNested(meta.model, value)];
  }

  return instantiateNested(meta.model, value);
}

/** Cria a função wrapper que faz a auto-conversão de tipos */
function wrapWithAutoConvert(originalMethod: Function) {
  return function (this: any, data: any) {
    const keysInModel = getFieldTypes(this);
    if (!data) return originalMethod.call(this, data);

    Object.keys(data).forEach((key) => {
      if (!(key in keysInModel)) return;

      // Campos aninhados declarados via @Field(Model)/@Field([Model]) são
      // instanciados/convertidos recursivamente. O @NestedModel "puro" NÃO
      // ativa isso (autoConvert=false), preservando o comportamento histórico.
      const nestedMeta = getNestedModelMeta(this, key);
      if (nestedMeta?.autoConvert) {
        data[key] = convertNestedValue(nestedMeta, data[key]);
        return;
      }

      const type = getFieldTypeByKey(this, key);
      data[key] = convertPrimitive(type, data[key]);
    });

    return originalMethod.call(this, data);
  };
}

/**
 * @AutoConvert - Decorator de método.
 * Suporta tanto o padrão legacy quanto o TC39 Stage 3.
 */
export function AutoConvert(...args: any[]): any {
  // New TC39 method decorator: (method, context)
  if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
    return wrapWithAutoConvert(args[0] as Function);
  }

  // Legacy method decorator: (target, propertyKey, descriptor)
  warnLegacy("AutoConvert");
  const descriptor = args[2] as PropertyDescriptor;
  descriptor.value = wrapWithAutoConvert(descriptor.value);
}

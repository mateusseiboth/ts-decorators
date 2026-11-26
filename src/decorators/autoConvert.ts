import { parseDate } from "../functions/parseDate";
import { getTemporalConverter } from "../functions/parseTemporal";
import { matchAsync } from "./_method";
import { isDecoratorContext, warnLegacy } from "./_proxy";
import { getFieldTypes } from "./initFields";
import { createMetadataCache } from "./metadata";
import { getNestedModels, type NestedModelMeta } from "./nestedModel";

type PrimitiveConverter = (val: any) => any;

const toNumber: PrimitiveConverter = (val) => {
  const n = Number(val);
  return isNaN(n) ? null : n;
};

const toBigInt: PrimitiveConverter = (val) => {
  try {
    return BigInt(val);
  } catch {
    return null;
  }
};

const FALSY_BOOLEANS = new Set<unknown>(["false", 0, "0", "N"]);
const TRUTHY_BOOLEANS = new Set<unknown>(["true", 1, "1", "S"]);

const toBoolean: PrimitiveConverter = (val) => {
  if (FALSY_BOOLEANS.has(val)) return false;
  if (TRUTHY_BOOLEANS.has(val)) return true;
  return Boolean(val);
};

const toString: PrimitiveConverter = (val) => String(val);

/**
 * Estratégias de conversão por tipo declarado no @Field. Cada tipo mapeia para
 * um conversor; tipos desconhecidos caem no fallback (mantém o valor original).
 */
const primitiveConverters: Record<string, PrimitiveConverter> = {
  number: toNumber,
  bigint: toBigInt,
  boolean: toBoolean,
  date: parseDate,
  string: toString,
};

/**
 * Resolve o conversor do tipo declarado: primitivos nativos primeiro, tipos do
 * Temporal (`zoneddatetime`, `Temporal.PlainDate`, `duration`…) em seguida.
 */
function findConverter(type: string | undefined): PrimitiveConverter | undefined {
  return primitiveConverters[type?.toLowerCase() ?? ""] ?? getTemporalConverter(type);
}

/**
 * Converte um único valor primitivo de acordo com o tipo declarado no @Field.
 * Mantém exatamente a mesma semântica histórica do @AutoConvert.
 */
export function convertPrimitive(type: string | undefined, val: any): any {
  return applyConverter(findConverter(type), val);
}

/** Aplica um conversor já resolvido, mantendo a semântica histórica do null. */
function applyConverter(converter: PrimitiveConverter | undefined, val: any): any {
  if (val === null || val === undefined) return null;
  return converter ? converter(val) : val;
}

/**
 * O que fazer com UM campo do model: converter primitivo ou montar a relação.
 *
 * O conversor já vem resolvido (nada de `toLowerCase()` + lookup por campo, por
 * requisição) e a relação já vem achatada.
 */
export interface FieldConversion {
  /** Conversor do tipo declarado; ausente = valor passa como veio. */
  convert?: PrimitiveConverter;
  /** Relação declarada via `@Field(Model)` / `@Field([Model])`. */
  nested?: NestedModelMeta;
}

export type ConversionPlan = ReadonlyMap<string, FieldConversion>;

const PLAN_CACHE = createMetadataCache<object, ConversionPlan>();

function buildConversionPlan(proto: any): ConversionPlan {
  const types = getFieldTypes(proto);
  const nestedModels = getNestedModels(proto);
  const plan = new Map<string, FieldConversion>();

  for (const key of Object.keys(types)) {
    const nested = nestedModels[key];
    // O @NestedModel "puro" (autoConvert=false) NÃO instancia nada — só o
    // @Field(Model)/@Field([Model]) ativa a conversão da relação.
    plan.set(key, nested?.autoConvert ? { nested } : { convert: findConverter(types[key]) });
  }

  return plan;
}

/**
 * Plano de conversão da classe da instância, montado uma única vez por classe.
 */
export function getConversionPlan(instance: any): ConversionPlan {
  const proto = instance != null ? Object.getPrototypeOf(instance) : null;
  if (!proto) return EMPTY_PLAN;
  return PLAN_CACHE.get(proto, buildConversionPlan);
}

const EMPTY_PLAN: ConversionPlan = new Map();

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
  const plan = getConversionPlan(instance);
  for (const k of Object.keys(item)) {
    const step = plan.get(k);
    if (!step) continue;
    // Aqui o @NestedModel "puro" TAMBÉM converte, como sempre converteu neste
    // fallback — o plano guarda só o que o @Field(Model) marcou, então a
    // relação é relida do model.
    const nested = step.nested ?? getNestedModels(instance)[k];
    instance[k] = nested
      ? convertNestedValue(nested, item[k])
      : applyConverter(step.convert, item[k]);
  }
  return instance;
}

/**
 * Converte o valor de um campo aninhado, respeitando se é lista ou objeto único.
 */
function convertNestedValue(meta: NestedModelMeta, value: any): any {
  if (value === null || value === undefined) return value;

  // Arrays são sempre convertidos item a item, mesmo quando o campo foi
  // declarado como to-one (@Field(Model)). Sem isso, o array inteiro seria
  // passado para `setData` de uma única instância — nenhuma chave bate e o
  // resultado fica só com os defaults da superclasse.
  if (Array.isArray(value)) return value.map((v) => instantiateNested(meta.model, v));

  // valor único informado para um campo de lista → normaliza para array
  if (meta.isArray) return [instantiateNested(meta.model, value)];

  return instantiateNested(meta.model, value);
}

/** Cria a função wrapper que faz a auto-conversão de tipos */
function wrapWithAutoConvert(originalMethod: Function): Function {
  return matchAsync(originalMethod, function (this: any, data: any) {
    if (!data) return originalMethod.call(this, data);

    const plan = getConversionPlan(this);
    for (const key of Object.keys(data)) {
      const step = plan.get(key);
      if (!step) continue;
      data[key] = step.nested
        ? convertNestedValue(step.nested, data[key])
        : applyConverter(step.convert, data[key]);
    }

    return originalMethod.call(this, data);
  });
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

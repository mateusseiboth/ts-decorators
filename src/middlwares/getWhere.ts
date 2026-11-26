import type { NextFunction, Request, Response } from "express";

import { OPTIONS_FILTER } from "../constants/default";
import { Controller } from "../Controller";
import { getModel } from "../decorators/getModel";
import { getFieldTypes, type FieldOptions } from "../decorators/initFields";
import { ClientError } from "../errors/commons";
import { normalizeValue, type FieldNormalize } from "../fields/normalize";
import { collectFieldMeta } from "../functions/collectFieldsTypes";
import { parseDate } from "../functions/parseDate";
import { isDateLikeFieldType } from "../functions/parseTemporal";
import { publishRequestValue } from "../handlers/context";

export function getWhere<T extends object>(
  req: Request,
  res: Response,
  next: NextFunction,
  classBase: { getModel: () => T; tag: number },
  customFields: Record<string, any> = {},
) {
  let where: Record<string, any> = {};
  const classRecord = getModel(classBase.tag);
  const {
    types: fieldTypes,
    listPaths,
    options: fieldOptions,
  } = collectFieldMeta(classRecord.prototype);

  const conditions: Record<string, any> = {};
  const errors: { path: string; message: string }[] = [];

  // Percorre a QUERY (2-3 chaves), não o model inteiro (dezenas de campos, mais
  // as relações achatadas). `hasOwn` garante que só campo declarado vira filtro.
  for (const key of Object.keys(req.query ?? {})) {
    if (!Object.hasOwn(fieldTypes, key) || !req.query[key]) continue;

    const condition = readCondicao(req.query[key] as string, key, fieldTypes, listPaths, errors, {
      fieldOptions,
    });
    if (!condition) continue;

    if (!conditions[key]) conditions[key] = {};
    if (condition.OR?.length) conditions[key].OR = [...(conditions[key].OR || []), ...condition.OR];
    if (condition.NOT?.length)
      conditions[key].NOT = [...(conditions[key].NOT || []), ...condition.NOT];
  }

  // Valor que não serve para o campo volta para a tela, com o campo em `path`: rodar a consulta
  // com outro valor devolveria uma lista errada sem ninguém perceber.
  if (errors.length > 0) {
    res.status(400).json({ message: "Filtro inválido.", errors });
    return;
  }

  const finalConditions = Object.values(conditions);

  if (finalConditions.length === 1) {
    where = finalConditions[0];
  } else if (finalConditions.length > 1) {
    where.AND = finalConditions;
  }

  if (
    Object.keys(conditions).length > 0 &&
    Object.values(conditions).every((cond) => cond.NOT && !cond.OR)
  ) {
    where = {
      ...where,
      NOT: Object.values(conditions)
        .map((cond) => cond.NOT)
        .flat(),
    };
  }

  if (Object.keys(customFields).length > 0) {
    where = {
      ...where,
      AND: [
        ...(where.AND || []),
        ...Object.entries(customFields).map(([key, value]) => ({ [key]: value })),
      ],
    };
  }

  publishRequestValue(res, "where", where);
  next();
}

/** A condição do campo; o valor inválido entra em `errors` e o campo fica sem condição. */
function readCondicao(
  value: string,
  key: string,
  fieldTypes: Record<string, string>,
  listPaths: Set<string>,
  errors: { path: string; message: string }[],
  meta: { fieldOptions: Record<string, FieldOptions> },
): Record<string, any> | null {
  try {
    return createWhereConditionQuery(value, key, fieldTypes, listPaths, meta.fieldOptions);
  } catch (erro) {
    if (!(erro instanceof FiltroInvalidoError)) throw erro;
    errors.push({ path: erro.path, message: erro.message });
    return null;
  }
}

/**
 * Cria condições para OR/NOT e nested fields.
 *
 * Quando um segmento do caminho corresponde a uma relação to-many (presente em
 * `listPaths`), o objeto aninhado é envolvido com `some`, produzindo um filtro
 * de lista válido no Prisma (ex.: `posts.title` -> `{posts: {some: {title: ...}}}`).
 */
function buildNestedCondition(
  key: string,
  value: any,
  listPaths: Set<string> = new Set(),
): Record<string, any> {
  const keys = key.split("."); // "Bem.name" -> ["Bem","name"]
  let nested = value;
  for (let i = keys.length - 1; i >= 0; i--) {
    const pathPrefix = keys.slice(0, i + 1).join(".");
    const inner = listPaths.has(pathPrefix) ? { some: nested } : nested;
    nested = { [keys[i] as keyof typeof nested]: inner };
  }
  return nested;
}

/** O que se sabe do campo filtrado, pelo tipo declarado no `@Field`. */
interface TipoDoCampo {
  /** O nome do campo na query, para a mensagem de valor inválido. */
  key: string;
  isNumeric: boolean;
  isString: boolean;
  isBoolean: boolean;
  isDate: boolean;
  /** O `normalize` do `@Field`: o filtro procura o valor como ele foi gravado. */
  normalize?: FieldNormalize;
}

/** `10-20`, `-5--1`, `1.5-2.5`. Um número negativo sozinho (`-5`) não é intervalo. */
const INTERVALO_NUMERICO = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/;
/** Duas datas ISO: o hífen que separa é o que vem antes do segundo ano. */
const INTERVALO_DE_DATAS_ISO = /^(\d{4}-\d{2}-\d{2}\S*?)-(\d{4}-\d{2}-\d{2}\S*)$/;
const TEM_HORA = /\d{1,2}:\d{2}/;

const NUMERO = /^-?\d+(?:\.\d+)?$/;

/**
 * Valor de filtro que não serve para o tipo do campo. O `getWhere` responde 400 com ele; quem
 * chama o `createWhereConditionQuery` direto recebe a exceção, com o campo em `path`.
 */
class FiltroInvalidoError extends ClientError {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Número de verdade, ou recusa. Descartar o que não é dígito fazia `1,5` virar 15 e `abc` virar
 * 0: o filtro rodava com um valor que ninguém pediu.
 */
const toNumber = (valor: string, campo: TipoDoCampo): number => {
  const limpo = valor.trim();
  if (!NUMERO.test(limpo)) {
    throw new FiltroInvalidoError(campo.key, `Informe um número válido no filtro "${campo.key}".`);
  }
  return Number(limpo);
};

/** Data sem hora vale o dia inteiro; com hora, o instante exato. Data que não existe é recusada. */
const toDate = (valor: string, campo: TipoDoCampo, borda: "inicio" | "fim"): Date => {
  const data = parseDate(valor.trim());
  if (!data) {
    throw new FiltroInvalidoError(campo.key, `Informe uma data válida no filtro "${campo.key}".`);
  }
  if (TEM_HORA.test(valor)) return data;
  const noDia = new Date(data);
  if (borda === "inicio") noDia.setHours(0, 0, 0, 0);
  else noDia.setHours(23, 59, 59, 999);
  return noDia;
};

const toEscalar = (valor: string, campo: TipoDoCampo): unknown => {
  if (campo.isNumeric) return toNumber(valor, campo);
  if (campo.isBoolean) return Controller.safe.Boolean(valor);
  return normalizeValue(valor, campo.normalize);
};

/** Valor de comparação (`gt`, `gte`, `lt`, `lte`): em data, a borda do dia que a comparação pede. */
const toComparavel = (valor: string, campo: TipoDoCampo, borda: "inicio" | "fim"): unknown =>
  campo.isDate ? toDate(valor, campo, borda) : toEscalar(valor, campo);

const splitIntervalo = (valor: string, campo: TipoDoCampo): [string, string] | null => {
  const padrao = campo.isDate ? INTERVALO_DE_DATAS_ISO : INTERVALO_NUMERICO;
  const achado = valor.match(padrao);
  if (achado) return [achado[1]!, achado[2]!];
  if (campo.isNumeric) return null;
  const partes = valor.split("-");
  return partes.length === 2 ? [partes[0]!, partes[1]!] : null;
};

const buildIntervalo = (valor: string, campo: TipoDoCampo): Record<string, unknown> | null => {
  const intervalo = splitIntervalo(valor, campo);
  if (!intervalo) return null;
  return {
    gte: toComparavel(intervalo[0], campo, "inicio"),
    lte: toComparavel(intervalo[1], campo, "fim"),
  };
};

const buildLista = (valor: string, campo: TipoDoCampo): unknown[] =>
  valor
    .split(",")
    .filter(Boolean)
    .map((item) => (campo.isDate ? toDate(item, campo, "inicio") : toEscalar(item, campo)));

const buildIgualdade = (valor: string, campo: TipoDoCampo): Record<string, unknown> => {
  if (campo.isDate)
    return { gte: toDate(valor, campo, "inicio"), lte: toDate(valor, campo, "fim") };
  // `10-20` sem prefixo, em campo numérico, é o intervalo inteiro numa condição só.
  const intervalo = campo.isNumeric ? buildIntervalo(valor, campo) : null;
  return intervalo ?? { equals: toEscalar(valor, campo) };
};

/** Busca por trecho só existe em texto; nos demais tipos vale a igualdade. */
const buildBuscaPorTexto =
  (operador: "contains" | "startsWith" | "endsWith") =>
  (valor: string, campo: TipoDoCampo): Record<string, unknown> =>
    campo.isString
      ? { [operador]: normalizeValue(valor, campo.normalize), mode: "insensitive" }
      : buildIgualdade(valor, campo);

interface Filtro {
  build: (valor: string, campo: TipoDoCampo) => Record<string, unknown>;
  /** O operador já é a negação de outro (`notInRange` é o `inRange` negado). */
  negate?: boolean;
}

/** Um construtor por operador de `OPTIONS_FILTER`. Operador novo entra aqui. */
const FILTROS: Record<string, Filtro> = {
  equals: { build: buildIgualdade },
  contains: { build: buildBuscaPorTexto("contains") },
  containing: { build: buildBuscaPorTexto("contains") },
  startsWith: { build: buildBuscaPorTexto("startsWith") },
  endsWith: { build: buildBuscaPorTexto("endsWith") },
  greaterThan: { build: (valor, campo) => ({ gt: toComparavel(valor, campo, "fim") }) },
  greaterThanOrEqual: { build: (valor, campo) => ({ gte: toComparavel(valor, campo, "inicio") }) },
  lessThan: { build: (valor, campo) => ({ lt: toComparavel(valor, campo, "inicio") }) },
  lessThanOrEqual: { build: (valor, campo) => ({ lte: toComparavel(valor, campo, "fim") }) },
  in: { build: (valor, campo) => ({ in: buildLista(valor, campo) }) },
  notIn: { build: (valor, campo) => ({ notIn: buildLista(valor, campo) }) },
  inRange: {
    build: (valor, campo) => buildIntervalo(valor, campo) ?? buildIgualdade(valor, campo),
  },
  notInRange: {
    build: (valor, campo) => buildIntervalo(valor, campo) ?? buildIgualdade(valor, campo),
    negate: true,
  },
  isNull: { build: () => ({ equals: null }) },
  notNull: { build: () => ({ not: null }) },
};

/** Tira o `!` da frente e diz se havia. */
const stripNegacao = (valor: string): { valor: string; isNegado: boolean } =>
  valor.startsWith("!") ? { valor: valor.slice(1), isNegado: true } : { valor, isNegado: false };

/** Separa o prefixo (`in:`, `greaterThan:`) do valor. Sem prefixo conhecido, devolve o valor inteiro. */
const splitOperador = (valor: string): { operador?: string; valor: string } => {
  const indice = valor.indexOf(":");
  const operador = indice > 0 ? valor.slice(0, indice) : "";
  return OPTIONS_FILTER.includes(operador)
    ? { operador, valor: valor.slice(indice + 1) }
    : { valor };
};

/** Campo cifrado não filtra: o mesmo valor gera textos diferentes no banco. */
const requireFiltravel = (key: string, opcoes: FieldOptions | undefined) => {
  if (!opcoes?.encrypted) return;
  throw new FiltroInvalidoError(key, `O campo "${key}" não pode ser usado em filtro.`);
};

export function createWhereConditionQuery(
  value: string | string[],
  key: string,
  modelBase: any,
  listPaths: Set<string> = new Set(),
  fieldOptions: Record<string, FieldOptions> = {},
): Record<string, any> {
  requireFiltravel(key, fieldOptions[key]);
  const rawValues: string[] = Array.isArray(value) ? value : value.split(";").filter(Boolean);
  const tipo = modelBase[key];
  const campo: TipoDoCampo = {
    normalize: fieldOptions[key]?.normalize,
    key,
    isNumeric: tipo === "number" || tipo === "bigint",
    isString: tipo === "string",
    isBoolean: tipo === "boolean",
    isDate: isDateLikeFieldType(tipo),
  };

  const OR: any[] = [];
  const NOT: any[] = [];

  // O operador vale para os valores seguintes da mesma chave: `startsWith:01;02`.
  let operadorAtual = "equals";
  for (const rawValue of rawValues) {
    if (!rawValue) continue;

    // O `!` nega antes ou depois do prefixo: `!in:1,2` e `in:!1,2`.
    const antes = stripNegacao(rawValue);
    const separado = splitOperador(antes.valor);
    const depois = stripNegacao(separado.valor);
    operadorAtual = separado.operador ?? operadorAtual;

    const filtro = FILTROS[operadorAtual] ?? FILTROS.equals!;
    const isNegado = antes.isNegado || depois.isNegado || filtro.negate === true;
    const condition = buildNestedCondition(key, filtro.build(depois.valor, campo), listPaths);

    (isNegado ? NOT : OR).push(condition);
  }

  return { OR, NOT };
}

export function buildWhereFromQuery<T extends object>(
  query: Record<string, any>,
  classBase: { getModel: () => T; tag: number },
  customFields: Record<string, any> = {},
) {
  const classRecord = getModel(classBase.tag);
  const fieldTypes = getFieldTypes(classRecord.prototype);
  const keys = Object.keys(fieldTypes).filter(
    (key) => Object.hasOwn(query, key) && query[key],
  ) as (keyof typeof query)[];

  const conditions = [] as any;

  keys.forEach((key) => {
    const condition =
      typeof query[key] === "object"
        ? { OR: [{ [key]: query[key] }] }
        : createWhereCondition(query[key] as string, key as string, fieldTypes);

    if (condition?.OR?.length > 0) {
      if (condition.OR.length > 1) {
        conditions.push({ OR: condition.OR });
      } else {
        conditions.push(condition.OR[0]);
      }
    }

    if (condition?.NOT?.length > 0) {
      if (condition.NOT.length > 1) {
        conditions.push({ NOT: { OR: condition.NOT } });
      } else {
        conditions.push({ NOT: condition.NOT[0] });
      }
    }
  });

  const finalWhere = {} as any;

  if (Object.keys(customFields).length > 0) {
    conditions.push({
      AND: Object.entries(customFields).map(([key, value]) => ({ [key]: value })),
    });
  }

  if (conditions.length > 1) {
    finalWhere.AND = conditions;
  } else if (conditions.length === 1) {
    Object.assign(finalWhere, conditions[0]);
  }

  return finalWhere;
}

/**
 * `isNull` e `notNull` no formato do `createWhereCondition`. O valor depois dos dois-pontos é
 * descartado: como texto, ele chegava ao banco como a data ou o número "null".
 */
const NULIDADE_SEM_EQUALS: Record<string, () => unknown> = {
  isNull: () => null,
  notNull: () => ({ not: null }),
};

export const createWhereCondition = (value: any, key: string, modelBase: any) => {
  if (typeof value === "object") return value;
  let internalValue = value;
  if (typeof value !== "string") {
    internalValue = String(value);
  }
  const parts = internalValue.split(":");
  let type = "equals";
  let valuesString = internalValue;

  if (parts.length > 1 && OPTIONS_FILTER.includes(parts[0])) {
    type = parts[0];
    valuesString = parts.slice(1).join(":");
  }

  const nulidade = NULIDADE_SEM_EQUALS[type];
  if (nulidade) return { OR: [{ [key]: nulidade() }], NOT: [] };

  const values = valuesString.split(";");

  const isNumericField = modelBase[key] === "number" || modelBase[key] === "bigint";
  const isStringField = modelBase[key] === "string";
  const isBooleanField = modelBase[key] === "boolean";

  const positiveValues = values.filter((v: string) => !v.startsWith("!")).filter(Boolean);
  const negativeValues = values
    .filter((v: string) => v.startsWith("!"))
    .map((v: string) => v.replace("!", ""))
    .filter(Boolean);

  let result = { OR: [], NOT: [] };

  const buildCondition = (val: string, type: string, isNumeric: boolean, isString: boolean) => {
    // Lógica para detectar e tratar intervalos (ranges)
    const isRange = val.includes("-");
    if (isRange) {
      const [min, max] = isNumeric ? val.split("-").map(Number) : val.split("-");
      return { [key]: { gte: min, lte: max } };
    }

    // Lógica para outros tipos de filtro
    const normalizedValue = isNumeric ? Number(val) : val;

    if (type === "equals" || type === "isNull" || type === "in") {
      let valueToUse: any = normalizedValue;
      if (OPTIONS_FILTER.includes(String(normalizedValue))) {
        const theFilterIs = OPTIONS_FILTER.find((f) => String(normalizedValue).includes(f));
        valueToUse = valueToUse.replace(theFilterIs || "", "").trim();
      }
      return { [key]: isBooleanField ? Controller.safe.Boolean(valueToUse) : valueToUse };
    }

    // Filtros que usam objetos de operador (contains, startsWith, etc.)
    if (type === "containing") type = "contains";

    if (isString) {
      return {
        [key]: {
          [type]: normalizedValue,
          mode: "insensitive",
        },
      };
    }

    return {
      [key]: {
        [type]: isBooleanField ? Controller.safe.Boolean(normalizedValue) : normalizedValue,
      },
    };
  };

  // Processar valores positivos
  result.OR = positiveValues.map((val: string) =>
    buildCondition(val, type, isNumericField, isStringField),
  );

  // Processar valores negativos
  result.NOT = negativeValues.map((val: string) =>
    buildCondition(val, type, isNumericField, isStringField),
  );

  return result;
};

import type {NextFunction, Request, Response} from "express";
import {OPTIONS_FILTER} from "../constants/default";
import {Controller} from "../Controller";
import {getModel} from "../decorators/getModel";
import {getFieldTypes} from "../decorators/initFields";
import {collectFieldTypes} from "../functions/collectFieldsTypes";

function expandRanges(rawValues: string[], isNumeric: boolean, typePrefix?: string) {
  const expanded: string[] = [];

  rawValues.forEach((val) => {
    if (!val) return;

    let type = typePrefix; // ex: "contains"
    let actualValue = val;

    // detecta se cada valor individual já tem um type separado
    if (val.includes(":")) {
      const parts = val.split(":");
      if (OPTIONS_FILTER.includes(parts[0] as string)) {
        type = parts[0];
        actualValue = parts.slice(1).join(":");
      }
    }

    const isNegative = actualValue.startsWith("!");
    let cleanVal = isNegative ? actualValue.slice(1) : actualValue;

    // só expande range se for numérico
    if (isNumeric && cleanVal.includes("-")) {
      const [start, end] = cleanVal.split("-").map(Number);
      //@ts-expect-error dynamic loop
      for (let i = start; i <= end; i++) {
        expanded.push(type ? `${type}:${isNegative ? "!" : ""}${i}` : `${isNegative ? "!" : ""}${i}`);
      }
    } else {
      expanded.push(type ? `${type}:${actualValue}` : actualValue);
    }
  });

  return expanded;
}

export function getWhere<T extends Object>(
  req: Request,
  res: Response,
  next: NextFunction,
  classBase: {getModel: () => T; tag: number},
  customFields: Record<string, any> = {},
) {
  let where: Record<string, any> = {};
  const classRecord = getModel(classBase.tag);
  const fieldTypes = collectFieldTypes(classRecord.prototype);
  const keys = Object.keys(fieldTypes as T extends {[key: string]: any} ? T : never);

  const conditions: Record<string, any> = {};

  keys.forEach((key) => {
    if (req.query[key]) {
      const condition = createWhereConditionQuery(req.query[key] as string, key, fieldTypes);

      if (!conditions[key]) conditions[key] = {};
      if (condition.OR?.length) conditions[key].OR = [...(conditions[key].OR || []), ...condition.OR];
      if (condition.NOT?.length) conditions[key].NOT = [...(conditions[key].NOT || []), ...condition.NOT];
    }
  });

  const finalConditions = Object.values(conditions);

  if (finalConditions.length === 1) {
    where = finalConditions[0];
  } else if (finalConditions.length > 1) {
    where.AND = finalConditions;
  }

  if (Object.keys(conditions).length > 0 && Object.values(conditions).every((cond) => cond.NOT && !cond.OR)) {
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
      AND: [...(where.AND || []), ...Object.entries(customFields).map(([key, value]) => ({[key]: value}))],
    };
  }

  res.locals.where = where;
  next();
}

/**
 * Cria condições para OR/NOT e nested fields
 */
function buildNestedCondition(key: string, value: any): Record<string, any> {
  const keys = key.split("."); // "Bem.name" -> ["Bem","name"]
  let nested = value;
  for (let i = keys.length - 1; i >= 0; i--) {
    nested = {[keys[i] as keyof typeof nested]: nested};
  }
  return nested;
}

export function createWhereConditionQuery(value: string | string[], key: string, modelBase: any): Record<string, any> {
  const rawValues: string[] = Array.isArray(value) ? value : value.split(";").filter(Boolean); // agora divide em múltiplos valores

  const isNumericField = modelBase[key] === "number" || modelBase[key] === "bigint";
  const isStringField = modelBase[key] === "string";
  const isBooleanField = modelBase[key] === "boolean";
  const isDate = modelBase[key] === "date" || modelBase[key] === "Date";

  const OR: any[] = [];
  const NOT: any[] = [];
  const finalValues = expandRanges(rawValues, isNumericField);

  let type = "equals";
  finalValues.forEach((val) => {
    if (!val) return;

    let actualValue = val;

    // tipo de filtro: contains, startsWith, etc.
    if (val.includes(":")) {
      const parts = val.split(":");
      if (OPTIONS_FILTER.includes(parts[0] as string)) {
        type = parts[0] as string;
        actualValue = parts.slice(1).join(":");
      }
    }

    const isNegative = actualValue.startsWith("!");
    if (isNegative) actualValue = actualValue.slice(1);

    if (isNumericField) {
      actualValue = actualValue.replace(/[^\d.-]/g, "");
    }

    const normalizedValue = isNumericField ? Number(actualValue) : actualValue;

    let condition: any;
    if (["contains", "startsWith", "endsWith"].includes(type) && isStringField) {
      condition = {
        [type]: normalizedValue,
        mode: "insensitive",
      };
    } else if (type === "equals") {
      if (isDate) {
        condition = {
          lte: new Date(new Date(normalizedValue).setHours(23, 59, 59, 999)),
          gte: new Date(new Date(normalizedValue).setHours(0, 0, 0, 0)),
        };
      } else {
        condition = {
          equals: !isBooleanField ? normalizedValue : Controller.safe.Boolean(normalizedValue),
        };
      }
    } else if (type === "greaterThan") {
      condition = {gt: normalizedValue};
    } else if (type === "lessThan") {
      condition = {lt: normalizedValue};
    } else if (type === "in") {
      condition = {
        in: String(normalizedValue)
          .split(",")
          .map((v) => (isNumericField ? Number(v) : v)),
      };
    } else if (type === "inRange") {
      const [min, max] = String(normalizedValue)
        .split("-")
        .map((v) => (isNumericField ? Number(v) : v));
      condition = {gte: min, lte: max};
    } else if (type === "isNull") {
      condition = {equals: null};
    } else {
      condition = {equals: normalizedValue};
    }

    const nestedCondition = buildNestedCondition(key, condition);

    if (isNegative) NOT.push(nestedCondition);
    else OR.push(nestedCondition);
  });

  return {OR, NOT};
}

export function buildWhereFromQuery<T extends Object>(
  query: Record<string, any>,
  classBase: {getModel: () => T; tag: number},
  customFields: Record<string, any> = {},
) {
  const classRecord = getModel(classBase.tag);
  const fieldTypes = getFieldTypes(classRecord.prototype);
  const keys = Object.keys(fieldTypes as T extends {[key: string]: any} ? T : never);

  const conditions = [] as any;

  keys.forEach((key) => {
    if (query[key]) {
      const condition =
        typeof query[key] === "object" ? {OR: [{[key]: query[key]}]} : createWhereCondition(query[key] as string, key, fieldTypes);

      if (condition?.OR?.length > 0) {
        if (condition.OR.length > 1) {
          conditions.push({OR: condition.OR});
        } else {
          conditions.push(condition.OR[0]);
        }
      }

      if (condition?.NOT?.length > 0) {
        if (condition.NOT.length > 1) {
          conditions.push({NOT: {OR: condition.NOT}});
        } else {
          conditions.push({NOT: condition.NOT[0]});
        }
      }
    }
  });

  const finalWhere = {} as any;

  if (Object.keys(customFields).length > 0) {
    conditions.push({
      AND: Object.entries(customFields).map(([key, value]) => ({[key]: value})),
    });
  }

  if (conditions.length > 1) {
    finalWhere.AND = conditions;
  } else if (conditions.length === 1) {
    Object.assign(finalWhere, conditions[0]);
  }

  return finalWhere;
}

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

  const values = valuesString.split(";");

  const isNumericField = modelBase[key] === "number" || modelBase[key] === "bigint";
  const isStringField = modelBase[key] === "string";
  const isBooleanField = modelBase[key] === "boolean";

  const positiveValues = values.filter((v: string) => !v.startsWith("!")).filter(Boolean);
  const negativeValues = values
    .filter((v: string) => v.startsWith("!"))
    .map((v: string) => v.replace("!", ""))
    .filter(Boolean);

  let result = {OR: [], NOT: []};

  const buildCondition = (val: string, type: string, isNumeric: boolean, isString: boolean) => {
    // Lógica para detectar e tratar intervalos (ranges)
    const isRange = val.includes("-");
    if (isRange) {
      const [min, max] = isNumeric ? val.split("-").map(Number) : val.split("-");
      return {[key]: {gte: min, lte: max}};
    }

    // Lógica para outros tipos de filtro
    const normalizedValue = isNumeric ? Number(val) : val;

    if (type === "equals" || type === "isNull" || type === "in") {
      let valueToUse: any = normalizedValue;
      if (OPTIONS_FILTER.includes(String(normalizedValue))) {
        const theFilterIs = OPTIONS_FILTER.find((f) => String(normalizedValue).includes(f));
        valueToUse = valueToUse.replace(theFilterIs || "", "").trim();
      }
      return {[key]: isBooleanField ? Controller.safe.Boolean(valueToUse) : valueToUse};
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
  result.OR = positiveValues.map((val: string) => buildCondition(val, type, isNumericField, isStringField));

  // Processar valores negativos
  result.NOT = negativeValues.map((val: string) => buildCondition(val, type, isNumericField, isStringField));

  return result;
};

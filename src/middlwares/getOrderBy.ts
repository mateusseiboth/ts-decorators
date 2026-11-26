import type { NextFunction, Request, Response } from "express";

import { getModel } from "../decorators/getModel";
import { collectFieldMeta } from "../functions/collectFieldsTypes";
import { publishRequestValue } from "../handlers/context";

/** Algum trecho do caminho é relação to-many? Lá não existe UMA linha para ordenar. */
const isCaminhoDeLista = (key: string, listPaths: Set<string>): boolean =>
  key.split(".").some((_, indice, partes) => listPaths.has(partes.slice(0, indice + 1).join(".")));

/** `"state.country.name"` → `{ state: { country: { name: "desc" } } }`, o formato do Prisma 7. */
const buildOrdem = (key: string, direcao: unknown): Record<string, unknown> =>
  key
    .split(".")
    .reduceRight<unknown>((interno, campo) => ({ [campo]: interno }), direcao) as Record<
    string,
    unknown
  >;

/**
 * A coluna que desempata a ordem: `static orderTieBreaker` do model (`false` desliga), ou `id`
 * quando o model tem esse campo. Sem desempate, registros com o mesmo valor trocam de lugar entre
 * uma página e outra.
 */
const readDesempate = (modelBase: any, types: Record<string, unknown>): string | undefined => {
  const declarado = modelBase?.orderTieBreaker as string | false | undefined;
  if (declarado === false) return undefined;
  const coluna = declarado ?? "id";
  return Object.hasOwn(types, coluna) ? coluna : undefined;
};

const isOrdemDa = (coluna: string) => (ordem: Record<string, unknown>) =>
  Object.keys(ordem).length === 1 && Object.hasOwn(ordem, coluna);

const withDesempate = (
  ordem: Record<string, unknown>[],
  coluna: string | undefined,
): Record<string, unknown>[] =>
  !coluna || ordem.some(isOrdemDa(coluna)) ? ordem : [...ordem, { [coluna]: "asc" }];

export function getOrderBy<T>(
  req: Request,
  res: Response,
  next: NextFunction,
  classBase: { getModel: () => T; tag: number },
) {
  const modelBase = getModel(classBase.tag);
  const meta = collectFieldMeta(modelBase.prototype);
  const desempate = readDesempate(modelBase, meta.types);

  if (!req.query.orderBy || !req.query.orderMethod) {
    if (desempate) publishRequestValue(res, "orderBy", withDesempate([], desempate));
    return next();
  }

  // Os tipos ACHATADOS do model (`contribuinte.name` incluído), os mesmos do `getWhere`: a tela
  // ordena pela coluna em que pesquisa. Consulta direta no mapa, sem varrer o model.
  // Campo cifrado não ordena: o mesmo valor gera textos diferentes no banco.
  const { types, listPaths, options } = meta;
  const key = req.query.orderBy;
  const orderBy =
    typeof key === "string" &&
    Object.hasOwn(types, key) &&
    !isCaminhoDeLista(key, listPaths) &&
    !options[key]?.encrypted
      ? [buildOrdem(key, req.query.orderMethod)]
      : [];

  publishRequestValue(res, "orderBy", withDesempate(orderBy, desempate));
  next();
}

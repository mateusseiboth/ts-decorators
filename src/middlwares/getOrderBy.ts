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

export function getOrderBy<T>(
  req: Request,
  res: Response,
  next: NextFunction,
  classBase: { getModel: () => T; tag: number },
) {
  const modelBase = getModel(classBase.tag);

  if (!req.query.orderBy || !req.query.orderMethod) return next();

  // Os tipos ACHATADOS do model (`contribuinte.name` incluído), os mesmos do `getWhere`: a tela
  // ordena pela coluna em que pesquisa. Consulta direta no mapa, sem varrer o model.
  const { types, listPaths } = collectFieldMeta(modelBase.prototype);
  const key = req.query.orderBy;
  const orderBy =
    typeof key === "string" && Object.hasOwn(types, key) && !isCaminhoDeLista(key, listPaths)
      ? [buildOrdem(key, req.query.orderMethod)]
      : [];

  publishRequestValue(res, "orderBy", orderBy);
  next();
}

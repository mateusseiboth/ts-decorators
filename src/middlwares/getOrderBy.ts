import type { NextFunction, Request, Response } from "express";

import { getModel } from "../decorators/getModel";
import { getFieldTypes } from "../decorators/initFields";

export function getOrderBy<T>(
  req: Request,
  res: Response,
  next: NextFunction,
  classBase: { getModel: () => T; tag: number },
) {
  const modelBase = getModel(classBase.tag);

  if (!req.query.orderBy || !req.query.orderMethod) return next();

  // Consulta direta no mapa de tipos: varrer todos os campos do model para achar
  // um só nome era O(campos) por requisição.
  const typedKeys = getFieldTypes(modelBase.prototype);
  const key = req.query.orderBy;
  const orderBy =
    typeof key === "string" && Object.hasOwn(typedKeys, key)
      ? [{ [key]: req.query.orderMethod }]
      : [];

  res.locals.orderBy = orderBy;
  next();
}

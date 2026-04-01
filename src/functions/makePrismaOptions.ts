import type {Response} from "express";

export const makePrismaOptions = (res: Response, _filterExercicio = false) => {
  const {where, orderBy, paginate} = res.locals;
  // Merge existing AND conditions with the new ones
  const mergedWhere = {
    ...where,
    AND: [...(where?.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : [])],
  };

  const optionsTpReturn = {
    where: mergedWhere,
    orderBy: orderBy ? [...orderBy] : undefined,
    ...paginate,
  };

  return optionsTpReturn;
};

export const removeFromWhere = (where: any, key: string) => {
  if (Array.isArray(where.where?.AND)) {
    where.where.AND = where.where.AND.map((andCond: any) => {
      if (andCond?.OR && Array.isArray(andCond.OR)) {
        return {
          ...andCond,
          OR: andCond.OR.filter((orCond: any) => !orCond?.[key]),
        };
      }
      if (andCond?.[key] !== undefined) {
        andCond[key] = undefined;
      }
      return andCond;
    });
  }
  return where;
};

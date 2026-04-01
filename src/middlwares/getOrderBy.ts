import type { NextFunction, Request, Response } from "express";
import { getModel } from "../decorators/getModel";
import { getFieldTypes } from "../decorators/initFields";

export function getOrderBy<T>(
    req: Request,
    res: Response,
    next: NextFunction,
    classBase: { getModel: () => T, tag: number }
) {
    const modelBase = getModel(classBase.tag);
    let orderBy = [] as any;

    if (!req.query.orderBy || !req.query.orderMethod) return next();
    const typedKeys = getFieldTypes(modelBase.prototype);
    const keys = Object.keys(typedKeys as T extends { [key: string]: any } ? T : never);

    keys.forEach((key) => {
        if (req.query.orderBy === key) {
            orderBy = [
                {
                    [key]: req.query.orderMethod,
                }
            ]
        }
    });

    res.locals.orderBy = orderBy;
    next();
}

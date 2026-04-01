import type { NextFunction, Request, Response } from "express";

export function getPaginate<T>(req: Request, res: Response, next: NextFunction) {


    if (req.headers.paginate === "true") {
        const page = req.headers.page ? parseInt(req.headers.page as string) : 1;
        const offset = req.headers.offset ? parseInt(req.headers.offset as string) : 10;
        const paginate = {
            skip: (page - 1) * offset,
            take: offset,
            page,
        };

        res.locals.paginate = paginate;
    }

    next();
}

import type { NextFunction, Request, Response } from "express";

import { publishRequestValue } from "../handlers/context";

export function getPaginate(req: Request, res: Response, next: NextFunction) {
  if (req.headers.paginate === "true") {
    const page = req.headers.page ? parseInt(req.headers.page as string) : 1;
    const offset = req.headers.offset ? parseInt(req.headers.offset as string) : 10;
    const paginate = {
      skip: (page - 1) * offset,
      take: offset,
      page,
    };

    publishRequestValue(res, "paginate", paginate);
  }

  next();
}

import type {NextFunction, Request, Response} from "express";
import {addCompanyIdToTransaction} from "../functions/sql";
import {getPrismaClient} from "./prisma";
import {requireHandlerContext} from "./context";

export function Transactional(options?: {
  timeout?: number;
  /** ReadUncommitted | ReadCommitted | RepeatableRead | Snapshot | Serializable */
  isolationLevel?: string;
  maxWait?: number;
}) {
  return function (handler: (req: Request, res: Response, next: NextFunction) => any) {
    return async function (req: Request, res: Response, next: NextFunction) {
      const prisma = getPrismaClient();
      return await prisma.$transaction(
        async (transaction: any) => {
          const ctx = requireHandlerContext("[@mateusseiboth/ts-commons] Context not found. Make sure withContext middleware is applied before the route.");
          ctx.transaction = transaction;
          await addCompanyIdToTransaction(transaction, ctx.entity as string);
          return handler(req, res, next);
        },
        {
          timeout: options?.timeout ?? 10_000,
          isolationLevel: options?.isolationLevel ?? "ReadCommitted",
          maxWait: options?.maxWait ?? 10_000,
        },
      );
    };
  };
}

import type {NextFunction, Request, Response} from "express";
import {AuditLogger} from "../storage/AuditLogger";
import {getHandlerContext} from "./context";

export function Audit(options?: {action?: string}) {
  return function (handler: (req: Request, res: Response, next: NextFunction) => any) {
    return async function (req: Request, res: Response, next: NextFunction) {
      const start = Date.now();

      let responseBody: unknown = undefined;
      let captured = false;

      const originalJson = res.json.bind(res);
      res.json = function (body: unknown) {
        if (!captured) {
          captured = true;
          responseBody = body;
        }
        return originalJson(body);
      };

      const originalSend = res.send.bind(res);
      res.send = function (body: unknown) {
        if (!captured) {
          captured = true;
          responseBody = body;
        }
        return originalSend(body);
      };

      const result = await handler(req, res, next);

      try {
        const ctx = getHandlerContext();
        AuditLogger.getInstance().log({
          method: req.method,
          url: req.originalUrl ?? req.url,
          action: options?.action,
          statusCode: res.statusCode,
          durationMs: Date.now() - start,
          requestBody: req.body,
          requestParams: req.params,
          requestQuery: req.query,
          responseBody,
          entity: ctx?.entity as number | undefined,
          exercicio: ctx?.exercicio,
          userId: ctx?.user?.id ?? ctx?.user?.userId,
          username: ctx?.user?.username,
          requestId: ctx?.requestId,
        });
      } catch (err) {
        console.error("[@mateusseiboth/ts-commons][Audit] Failed to log:", err);
      }

      return result;
    };
  };
}

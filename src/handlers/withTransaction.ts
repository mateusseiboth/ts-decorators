import type {NextFunction, Request, Response} from "express";
import {Audit} from "./Audit";
import type {CompanyIdInjector} from "./companyId";
import {compose} from "./compose";
import {Transactional as TransactionalHandler} from "./Transactional";

export function withTransaction(
  fn: (req: Request, res: Response, next: NextFunction) => any,
  action?: {action: string},
  options: {
    timeout?: number;
    isolationLevel?: string;
    maxWait?: number;
    companyIdInjector?: CompanyIdInjector;
  } = {},
) {
  return compose(TransactionalHandler(options), Audit(action))(fn);
}

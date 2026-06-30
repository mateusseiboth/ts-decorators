import {Router} from "express";
import type {RequestHandler} from "express";
import {getOrderBy} from "../middlwares/getOrderBy";
import {getPaginate} from "../middlwares/getPaginate";
import {getWhere} from "../middlwares/getWhere";

type HttpHandler = RequestHandler;

export class RouteBuilder {
  constructor(
    private router: Router,
    private defaultMiddlewares: HttpHandler[] = [],
  ) {}

  private mergeHandlers(handlers: HttpHandler[]) {
    return [...this.defaultMiddlewares, ...handlers];
  }

  get(path: string, ...handlers: HttpHandler[]) {
    this.router.get(path, ...this.mergeHandlers(handlers));
  }

  post(path: string, ...handlers: HttpHandler[]) {
    this.router.post(path, ...this.mergeHandlers(handlers));
  }

  put(path: string, ...handlers: HttpHandler[]) {
    this.router.put(path, ...this.mergeHandlers(handlers));
  }

  patch(path: string, ...handlers: HttpHandler[]) {
    this.router.patch(path, ...this.mergeHandlers(handlers));
  }

  delete(path: string, ...handlers: HttpHandler[]) {
    this.router.delete(path, ...this.mergeHandlers(handlers));
  }

  options(path: string, ...handlers: HttpHandler[]) {
    this.router.options(path, ...this.mergeHandlers(handlers));
  }

  head(path: string, ...handlers: HttpHandler[]) {
    this.router.head(path, ...this.mergeHandlers(handlers));
  }

  all(path: string, ...handlers: HttpHandler[]) {
    this.router.all(path, ...this.mergeHandlers(handlers));
  }

  use(...handlers: HttpHandler[]) {
    this.router.use(...this.mergeHandlers(handlers));
  }

  extend(middlewares: RequestHandler[]) {
    return new RouteBuilder(this.router, [...this.defaultMiddlewares, ...middlewares]);
  }

  withPrismaOptions<T extends {tag: number; getModel: () => any}>(model: T) {
    return this.extend([
      (req, res, next) => getOrderBy<T>(req, res, next, model),

      (req, res, next) => getWhere<T>(req, res, next, model),

      getPaginate,
    ]);
  }
}

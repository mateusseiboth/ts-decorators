import { Router } from "express";
import type { RequestHandler } from "express";

import { getColumns } from "../middlwares/getColumns";
import { getOrderBy } from "../middlwares/getOrderBy";
import { createPaginate, type PaginateMiddlewareOptions } from "../middlwares/getPaginate";
import { getWhere } from "../middlwares/getWhere";

type HttpHandler = RequestHandler;

export interface WithPrismaOptionsConfig {
  /** Paginação desta rota. Vence o `static paginate` do model. */
  paginate?: PaginateMiddlewareOptions;
}

/** O model que declara a própria paginação: `static paginate = { required: true, maxOffset: 100 }`. */
type ModelComPaginacao = { paginate?: PaginateMiddlewareOptions };

export class RouteBuilder {
  constructor(
    protected router: Router,
    protected defaultMiddlewares: HttpHandler[] = [],
  ) {}

  protected mergeHandlers(handlers: HttpHandler[]) {
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

  /** Um builder com os middlewares a mais; na subclasse, devolve a subclasse. */
  extend(middlewares: RequestHandler[]): this {
    const Builder = this.constructor as new (router: Router, middlewares: HttpHandler[]) => this;
    return new Builder(this.router, [...this.defaultMiddlewares, ...middlewares]);
  }

  withPrismaOptions<T extends { tag: number; getModel: () => any }>(
    model: T,
    config: WithPrismaOptionsConfig = {},
  ) {
    const paginate = createPaginate(config.paginate ?? (model as ModelComPaginacao).paginate);
    return this.extend([
      (req, res, next) => getOrderBy<T>(req, res, next, model),

      (req, res, next) => getWhere<T>(req, res, next, model),

      (req, res, next) => getColumns<T>(req, res, next, model),

      paginate,
    ]);
  }
}

import { Router } from "express";
import type { RequestHandler } from "express";

import { getColumns } from "../middlwares/getColumns";
import { getOrderBy } from "../middlwares/getOrderBy";
import { createPaginate, type PaginateMiddlewareOptions } from "../middlwares/getPaginate";
import { getWhere } from "../middlwares/getWhere";
import type { HttpMethod, RouteDefinition, RouteOptions } from "./http-methods";
import { withRespond, type RouteHandler, type RouteResponder } from "./routeResponse";

type HttpHandler = RequestHandler;

/** Marca a rota que veio do `applyControllerRoutes`: o builder não a lista como declarada. */
export const ROUTE_FROM_CONTROLLER = Symbol("ts-decorators:route-from-controller");

export interface RouteBuilderConfig {
  /**
   * Responde com o que o último handler da rota devolveu, depois que ele termina (o `respond` do
   * `applyControllerRoutes`, para as rotas do `declareRoutes()`). Vale também nos builders do
   * `extend`.
   */
  respond?: RouteResponder;
  /** Lista onde as rotas ficam anotadas. Interno: o `extend` passa a mesma adiante. */
  routes?: RouteDefinition[];
}

/** Os handlers da rota, com as opções (`doc`...) no segundo argumento, quando vierem. */
type RouteArgs = [RouteOptions, ...RouteHandler[]] | RouteHandler[];

const isOpcoes = (valor: unknown): valor is RouteOptions =>
  typeof valor === "object" && valor !== null && !Array.isArray(valor);

const splitArgs = (args: RouteArgs): [RouteOptions, RouteHandler[]] =>
  isOpcoes(args[0]) ? [args[0], args.slice(1) as RouteHandler[]] : [{}, args as RouteHandler[]];

/** O nome do último handler, para a definição (`handlerName`). */
const nameOf = (handlers: RouteHandler[]): string => handlers.at(-1)?.name ?? "";

export interface WithPrismaOptionsConfig {
  /** Paginação desta rota. Vence o `static paginate` do model. */
  paginate?: PaginateMiddlewareOptions;
}

/** O model que declara a própria paginação: `static paginate = { required: true, maxOffset: 100 }`. */
type ModelComPaginacao = { paginate?: PaginateMiddlewareOptions };

export class RouteBuilder {
  /** O `respond` e a lista de rotas, compartilhados com os builders do `extend`. */
  protected readonly config: { respond?: RouteResponder; routes: RouteDefinition[] };

  constructor(
    protected router: Router,
    protected defaultMiddlewares: HttpHandler[] = [],
    config: RouteBuilderConfig = {},
  ) {
    this.config = { respond: config.respond, routes: config.routes ?? [] };
  }

  protected mergeHandlers(handlers: HttpHandler[]) {
    return [...this.defaultMiddlewares, ...handlers];
  }

  /** As rotas registradas por este builder e pelos do `extend` (as do `declareRoutes()`). */
  definitions(): RouteDefinition[] {
    return [...this.config.routes];
  }

  /**
   * Registra a rota: anota a definição (método, caminho, opções e `doc`) e põe o `respond` depois
   * do último handler. O segundo argumento pode ser as opções da rota: `get("/", { doc }, fn)`.
   */
  protected addRoute(method: HttpMethod, path: string, args: RouteArgs): void {
    const [options, handlers] = splitArgs(args);
    const def: RouteDefinition = { method, path, handlerName: nameOf(handlers), options };
    if (!(options as Record<symbol, unknown>)[ROUTE_FROM_CONTROLLER]) this.config.routes.push(def);
    const finais = handlers.map((handler, indice) =>
      indice === handlers.length - 1 ? withRespond(handler, this.config.respond, def) : handler,
    );
    (this.router[method] as (path: string, ...h: unknown[]) => unknown)(
      path,
      ...this.mergeHandlers(finais as HttpHandler[]),
    );
  }

  get(path: string, ...args: RouteArgs) {
    this.addRoute("get", path, args);
  }

  post(path: string, ...args: RouteArgs) {
    this.addRoute("post", path, args);
  }

  put(path: string, ...args: RouteArgs) {
    this.addRoute("put", path, args);
  }

  patch(path: string, ...args: RouteArgs) {
    this.addRoute("patch", path, args);
  }

  delete(path: string, ...args: RouteArgs) {
    this.addRoute("delete", path, args);
  }

  options(path: string, ...args: RouteArgs) {
    this.addRoute("options", path, args);
  }

  head(path: string, ...args: RouteArgs) {
    this.addRoute("head", path, args);
  }

  all(path: string, ...args: RouteArgs) {
    this.addRoute("all", path, args);
  }

  use(...handlers: HttpHandler[]) {
    this.router.use(...this.mergeHandlers(handlers));
  }

  /** Um builder com os middlewares a mais; na subclasse, devolve a subclasse. */
  extend(middlewares: RequestHandler[]): this {
    const Builder = this.constructor as new (
      router: Router,
      middlewares: HttpHandler[],
      config: RouteBuilderConfig,
    ) => this;
    return new Builder(this.router, [...this.defaultMiddlewares, ...middlewares], this.config);
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

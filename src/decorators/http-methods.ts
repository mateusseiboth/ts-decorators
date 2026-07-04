import "reflect-metadata";

import type {RequestHandler} from "express";

import type {RouteBuilder} from "./router-builder";

/**
 * Decorators de rota no estilo NestJS (@Get, @Post, @Put, ...).
 *
 * Marcam métodos de um controller com o verbo HTTP + path (incluindo params,
 * ex.: `@Get(":id/carne")`). A metadata é lida depois por `applyControllerRoutes`,
 * que registra cada rota no RouteBuilder apropriado — integrando-se ao sistema
 * atual de global-router / RegistryRouter sem substituí-lo.
 *
 * Exemplo:
 * ```ts
 * @Injectable()
 * export class LoteController extends BaseController {
 *   @Get("/", {use: "routeWithPaginate", action: "LIST"})
 *   async get(req, res, next) { ... }
 *
 *   @Post("/", {action: "CREATE"})
 *   async create(req, res, next) { ... }
 *
 *   @Put("/:id", {action: "UPDATE"})
 *   async update(req, res, next) { ... }
 *
 *   @Delete("/:id", {use: "routeWithIdempotency", action: "DELETE"})
 *   async deleteById(req, res, next) { ... }
 *
 *   @Get("/:id", {action: "GET"})
 *   async getById(req, res, next) { ... }
 * }
 * ```
 */

export const HTTP_ROUTES_KEY = Symbol("HTTP_ROUTES_KEY");

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "options"
  | "head"
  | "all";

export interface RouteOptions {
  /**
   * Nome da propriedade RouteBuilder a usar no registry ao aplicar a rota
   * (ex.: "routeWithPaginate", "routeWithIdempotency"). Default: "route".
   */
  use?: string;
  /**
   * Transforma o builder resolvido *só para esta rota*, antes de registrar.
   * Útil para compor middlewares custom pontuais sem criar uma propriedade
   * dedicada no registry — ex.: `build: (b) => b.withPrismaOptions(Model)`.
   */
  build?: (builder: RouteBuilder, def: RouteDefinition) => RouteBuilder;
  /** Metadata livre repassada ao wrapper — ex.: `{action: "LIST"}`. */
  [key: string]: any;
}

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handlerName: string;
  options: RouteOptions;
}

function createMethodDecorator(method: HttpMethod) {
  return (path = "/", options: RouteOptions = {}): MethodDecorator => {
    return (target, propertyKey) => {
      const ctor = (target as any).constructor;
      const routes: RouteDefinition[] = Reflect.getOwnMetadata(HTTP_ROUTES_KEY, ctor) ?? [];
      routes.push({method, path, handlerName: String(propertyKey), options});
      Reflect.defineMetadata(HTTP_ROUTES_KEY, routes, ctor);
    };
  };
}

export const Get = createMethodDecorator("get");
export const Post = createMethodDecorator("post");
export const Put = createMethodDecorator("put");
export const Patch = createMethodDecorator("patch");
export const Delete = createMethodDecorator("delete");
export const Options = createMethodDecorator("options");
export const Head = createMethodDecorator("head");
export const All = createMethodDecorator("all");

/**
 * Coleta todas as rotas declaradas num controller, percorrendo a cadeia de
 * protótipos para herdar rotas de classes base (ex.: um BaseController).
 * Rotas mais específicas (subclasse) têm precedência sobre as herdadas.
 */
export function getControllerRoutes(target: any): RouteDefinition[] {
  const collected: RouteDefinition[] = [];
  const seen = new Set<string>();
  let ctor = typeof target === "function" ? target : target?.constructor;

  while (ctor && ctor !== Function.prototype && ctor !== Object) {
    const routes: RouteDefinition[] = Reflect.getOwnMetadata(HTTP_ROUTES_KEY, ctor) ?? [];
    for (const route of routes) {
      const key = `${route.method} ${route.path} ${route.handlerName}`;
      if (!seen.has(key)) {
        seen.add(key);
        collected.push(route);
      }
    }
    ctor = Object.getPrototypeOf(ctor);
  }

  return collected;
}

/**
 * Envolve o handler bruto do controller antes de registrá-lo — ponto de
 * extensão para try/catch, withTransaction, auditoria, etc. Recebe a definição
 * da rota (com `options.action` e afins) e a função que chama o método do
 * controller. Pode devolver um ou vários handlers.
 */
export type RouteWrapper = (
  def: RouteDefinition,
  invoke: RequestHandler,
) => RequestHandler | RequestHandler[];

export interface ApplyControllerRoutesConfig {
  /** Instância do controller cujos métodos foram decorados. */
  controller: any;
  /**
   * Conjunto explícito de rotas a registrar. Se ausente, usa as rotas decoradas
   * no próprio controller (`getControllerRoutes`). Passe uma lista para combinar
   * fontes — ex.: `[...getRestRoutes(this), ...getControllerRoutes(controller)]`.
   */
  routes?: RouteDefinition[];
  /**
   * Resolve qual RouteBuilder usar a partir de `options.use`. Normalmente
   * mapeia para as propriedades do registry (this.route, this.routeWithPaginate...).
   */
  resolveBuilder: (use: string | undefined, def: RouteDefinition) => RouteBuilder;
  /** Envolve cada handler. Se ausente, o método do controller é chamado direto. */
  wrap?: RouteWrapper;
}

/**
 * Lê as rotas (decoradas no controller e/ou explícitas) e as registra nos
 * RouteBuilders, substituindo o `declareRoutes()` manual do BaseRegistry.
 * Rotas cujo handler não existe no controller são ignoradas com um aviso.
 */
export function applyControllerRoutes(config: ApplyControllerRoutesConfig): void {
  const {controller, resolveBuilder, wrap} = config;
  const routes = config.routes ?? getControllerRoutes(controller);

  for (const def of routes) {
    if (typeof controller[def.handlerName] !== "function") {
      console.warn(
        `[applyControllerRoutes] handler "${def.handlerName}" não existe no controller — ` +
          `rota ${def.method.toUpperCase()} ${def.path} ignorada`,
      );
      continue;
    }

    const invoke: RequestHandler = (req, res, next) =>
      controller[def.handlerName](req, res, next);

    const handlers = wrap ? wrap(def, invoke) : invoke;
    const handlerArray = Array.isArray(handlers) ? handlers : [handlers];

    const base = resolveBuilder(def.options.use, def);
    const builder =
      typeof def.options.build === "function" ? def.options.build(base, def) : base;
    (builder as any)[def.method](def.path, ...handlerArray);
  }
}

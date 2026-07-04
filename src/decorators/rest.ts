import "reflect-metadata";

import type {HttpMethod, RouteDefinition, RouteOptions} from "./http-methods";

/**
 * @Rest() — decorator de classe (no registry) que semeia o CRUD padrão sem
 * você escrever cada rota na mão. Reproduz exatamente a convenção do BaseRegistry:
 *
 *   LIST    GET    /       -> controller.get         use: routeWithPaginate     action: LIST
 *   GET     GET    /:id    -> controller.getById     use: route                 action: GET
 *   CREATE  POST   /       -> controller.create      use: routeWithExtraInfo    action: CREATE
 *   UPDATE  PUT    /:id    -> controller.update       use: routeWithExtraInfo    action: UPDATE
 *   DELETE  DELETE /:id    -> controller.deleteById   use: routeWithIdempotency  action: DELETE
 *
 * Você continua configurando os builders no `configure()` (inclusive um
 * ExtendedRouterBuilder com métodos custom); o `use` só referencia o nome da
 * propriedade. Ajuste o preset com `only` / `except` / `overrides`.
 *
 * ```ts
 * @Injectable()
 * @Rest({except: ["delete"], overrides: {list: {use: "routeWithPaginate"}}})
 * export class Registry extends BaseRegistry {
 *   constructor(protected readonly controller: LoteController) { super(controller); }
 * }
 * ```
 */

export const REST_CONFIG_KEY = Symbol("REST_CONFIG_KEY");

export type RestAction = "list" | "get" | "create" | "update" | "delete";

interface RestPresetEntry {
  method: HttpMethod;
  path: string;
  handlerName: string;
  action: string;
  use: string;
}

/** Preset padrão de CRUD — espelha o BaseRegistry atual. Exportado para inspeção/reuso. */
export const REST_PRESET: Record<RestAction, RestPresetEntry> = {
  list: {method: "get", path: "/", handlerName: "get", action: "LIST", use: "routeWithPaginate"},
  get: {method: "get", path: "/:id", handlerName: "getById", action: "GET", use: "route"},
  create: {method: "post", path: "/", handlerName: "create", action: "CREATE", use: "routeWithExtraInfo"},
  update: {method: "put", path: "/:id", handlerName: "update", action: "UPDATE", use: "routeWithExtraInfo"},
  delete: {method: "delete", path: "/:id", handlerName: "deleteById", action: "DELETE", use: "routeWithIdempotency"},
};

export interface RestOverride {
  method?: HttpMethod;
  path?: string;
  /** Nome do método do controller que trata a rota. */
  handlerName?: string;
  /** Nome da propriedade RouteBuilder no registry. */
  use?: string;
  /** Options extras mescladas em `options` (ex.: `build`, `action` custom). */
  options?: RouteOptions;
}

export interface RestConfig {
  /** Restringe às ações listadas (whitelist). */
  only?: RestAction[];
  /** Remove as ações listadas (blacklist). */
  except?: RestAction[];
  /** Customiza path/verbo/handler/builder/options por ação. */
  overrides?: Partial<Record<RestAction, RestOverride>>;
}

export function Rest(config: RestConfig = {}): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(REST_CONFIG_KEY, config, target);
  };
}

/**
 * Resolve o `@Rest()` de uma classe para a lista de RouteDefinition — o mesmo
 * formato produzido por `@Get`/`@Post`, pronto para `applyControllerRoutes`.
 * Retorna `[]` se a classe não tem `@Rest()`.
 */
export function getRestRoutes(target: any): RouteDefinition[] {
  const ctor = typeof target === "function" ? target : target?.constructor;
  const config: RestConfig | undefined = ctor && Reflect.getMetadata(REST_CONFIG_KEY, ctor);
  if (!config) return [];

  const all = Object.keys(REST_PRESET) as RestAction[];
  const actions = (config.only ?? all).filter((a) => !config.except?.includes(a));

  return actions.map((action) => {
    const preset = REST_PRESET[action];
    const ov = config.overrides?.[action] ?? {};
    return {
      method: ov.method ?? preset.method,
      path: ov.path ?? preset.path,
      handlerName: ov.handlerName ?? preset.handlerName,
      options: {
        use: ov.use ?? preset.use,
        action: preset.action,
        ...ov.options,
      },
    };
  });
}

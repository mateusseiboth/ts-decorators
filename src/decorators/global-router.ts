import "reflect-metadata";
import { logger } from "../functions/logger";
import { folderRouter } from "./folder-router";
import { ROUTERS_KEY } from "./router-metadata";

/** O que o `@GlobalRouter` acrescenta à classe. */
export interface GlobalRouterHost {
  initializeRoutes(): Promise<void>;
}

/**
 * Base para a classe do servidor: decorator não muda o tipo da classe no TypeScript, então o
 * `initializeRoutes` que o `@GlobalRouter` acrescenta é declarado aqui, sem cast no projeto.
 *
 * ```ts
 * @GlobalRouter()
 * export class Server extends GlobalRouterApp {
 *   app = express();
 * }
 * await new Server().initializeRoutes();
 * ```
 */
export class GlobalRouterApp implements GlobalRouterHost {
  declare initializeRoutes: () => Promise<void>;
}

type Construtor = new (...args: any[]) => any;

export function GlobalRouter() {
  return function <T extends Construtor>(
    constructor: T,
  ): T & (new (...args: any[]) => GlobalRouterHost) {
    return class extends constructor implements GlobalRouterHost {
      async initializeRoutes() {
        const routes = Reflect.getMetadata(ROUTERS_KEY, constructor.prototype) || [];
        logger.debug(
          `Initializing routes for class: ${constructor.name}, found ${routes.length} route(s)`,
        );
        for (const route of routes) {
          await folderRouter(this.app, route.folder, {
            middlewares: route.middlewares,
            prefix: route.prefix,
            mergeParams: route.mergeParams,
          });

          if (typeof this[route.methodName] === "function") {
            await this[route.methodName]();
          }
        }
      }
    };
  };
}

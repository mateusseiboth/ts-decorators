import "reflect-metadata";

import { ROUTERS_KEY } from "./router-metadata";

import { folderRouter } from "./folder-router";

export function GlobalRouter() {
  return function <T extends new (...args: any[]) => any>(constructor: T) {
    return class extends constructor {
      async initializeRoutes() {
        const routes = Reflect.getMetadata(ROUTERS_KEY, constructor.prototype) || [];
        console.log(
          `Initializing routes for class: ${constructor.name}, found ${routes.length} route(s)`,
        );
        for (const route of routes) {
          await folderRouter(this.app, route.folder, {
            middlewares: route.middlewares,
            prefix: route.prefix,
          });

          if (typeof this[route.methodName] === "function") {
            await this[route.methodName]();
          }
        }
      }
    };
  };
}

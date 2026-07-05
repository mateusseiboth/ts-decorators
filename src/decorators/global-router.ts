import "reflect-metadata";

import {folderRouter} from "./folder-router";
import {ROUTERS_KEY} from "./router-metadata";

export function GlobalRouter() {
  return function <T extends new (...args: any[]) => any>(constructor: T) {
    return class extends constructor {
      async initializeRoutes() {
        const routes = Reflect.getMetadata(ROUTERS_KEY, constructor.prototype) || [];

        console.log(`
┌─────────────────────────────────────────────────────┐
│ 🚀 Global Router                                    │
├─────────────────────────────────────────────────────┤
│ Class   : ${constructor.name.padEnd(39)}│
│ Routes  : ${String(routes.length).padEnd(39)}│
└─────────────────────────────────────────────────────┘
`);

        for (const route of routes) {
          console.log(
            `  ├─ 📂 ${route.folder}\n` +
              `  │  Prefix : ${route.prefix || "/"}\n` +
              `  │  Method : ${route.methodName}\n` +
              `  │  Middleware(s): ${route.middlewares?.length ?? 0}`,
          );

          await folderRouter(this.app, route.folder, {
            middlewares: route.middlewares,
            prefix: route.prefix,
          });

          if (typeof this[route.methodName] === "function") {
            await this[route.methodName]();
            console.log(`  └─ ✅ ${route.methodName} initialized\n`);
          } else {
            console.log(`  └─ ⚠️ ${route.methodName} not found\n`);
          }
        }

        console.log(`✨ ${constructor.name} finished loading.\n`);
      }
    };
  };
}

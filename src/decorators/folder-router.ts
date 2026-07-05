import fs from "fs/promises";
import path from "path";

import type {Express, RequestHandler} from "express";
import {Router} from "express";

import {validateRouteFile} from "./validate-route-file";

export const AllRouters: Record<string, any> = {};

type FolderRouterOptions = {
  middlewares?: RequestHandler[];
  prefix?: string;
};

const log = {
  start(baseFolder: string, prefix?: string) {
    console.log(`
┌──────────────────────────────────────────────────────────────┐
│ 🚀 Route Scanner                                             │
├──────────────────────────────────────────────────────────────┤
│ Base   │ ${baseFolder}
│ Prefix │ ${prefix || "/"}
└──────────────────────────────────────────────────────────────┘`);
  },

  file(file: string) {
    console.log(`🔍 ${file}`);
  },

  skip(reason: string) {
    console.log(`   └─ ⏭️  ${reason}`);
  },

  mounted({
    path,
    file,
    globalMiddlewares,
    routeMiddlewares,
  }: {
    path: string;
    file: string;
    globalMiddlewares: number;
    routeMiddlewares: number;
  }) {
    console.log(`   ├─ ✅ Mounted
   │  URL         : ${path}
   │  File        : ${file}
   │  Middlewares : ${globalMiddlewares} global + ${routeMiddlewares} local`);
  },

  finish() {
    console.log("\n✨ Route scan completed.\n");
  },
};

export async function folderRouter(app: Express, baseFolder: string, options?: FolderRouterOptions) {
  const globalMiddlewares = options?.middlewares || [];

  log.start(baseFolder, options?.prefix);

  async function scan(currentDir: string) {
    const entries = await fs.readdir(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
        continue;
      }

      log.file(fullPath);

      const isIndexFile = entry.name === "index.ts" || entry.name === "index.js";

      if (!isIndexFile) {
        log.skip("Not an index file");
        continue;
      }

      const isValid = await validateRouteFile(fullPath);

      if (!isValid) {
        log.skip("No registry() export found");
        continue;
      }

      const imported = await import(fullPath);

      if (typeof imported.registry !== "function") {
        log.skip("registry is not a function");
        continue;
      }

      const relativeDir = path.relative(baseFolder, currentDir);

      const routePath = (options?.prefix ?? "") + "/" + relativeDir.split(path.sep).filter(Boolean).join("/");

      const router = Router();

      const routeMiddlewares = imported.middlewares || [];

      app.use(routePath, ...globalMiddlewares, ...routeMiddlewares, router);

      await imported.registry(router);
      AllRouters[routePath] = {
        path: routePath,
        file: fullPath,
        globalMiddlewares: globalMiddlewares.length,
        routeMiddlewares: routeMiddlewares.length,
      };
      log.mounted({
        path: routePath,
        file: fullPath,
        globalMiddlewares: globalMiddlewares.length,
        routeMiddlewares: routeMiddlewares.length,
      });
    }
  }

  await scan(baseFolder);

  log.finish();
}

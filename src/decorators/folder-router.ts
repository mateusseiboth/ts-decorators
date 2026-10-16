import fs from "fs/promises";
import path from "path";

import { Router } from "express";
import type { Express, RequestHandler } from "express";

import { logger } from "../functions/logger";
import {
  endpointsOf,
  formatRoutesTable,
  recordRoute,
  type RegisteredRoute,
} from "./route-registry";
import { validateRouteFile } from "./validate-route-file";

/** Rota montada pelo `folderRouter`, como o `AllRouters` a expõe. */
export interface MountedRouter extends RegisteredRoute {
  /** Arquivo `index.ts` que declarou a rota. */
  file: string;
  globalMiddlewares: number;
  routeMiddlewares: number;
}

/**
 * Toda rota montada pelo `folderRouter`, por caminho de montagem. O projeto lê daqui para
 * listar o que subiu (o `getRegisteredRoutes` traz o mesmo, em ordem de montagem).
 */
export const AllRouters: Record<string, MountedRouter> = {};

type FolderRouterOptions = {
  middlewares?: RequestHandler[];
  prefix?: string;
};

export async function folderRouter(
  app: Express,
  baseFolder: string,
  options?: FolderRouterOptions,
) {
  const globalMiddlewares = options?.middlewares || [];
  const montadas: RegisteredRoute[] = [];

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

      const isIndexFile = entry.name === "index.ts" || entry.name === "index.js";
      logger.debug(`Found file: ${fullPath}, isIndexFile: ${isIndexFile}`);
      if (!isIndexFile) {
        continue;
      }

      const isValid = await validateRouteFile(fullPath);
      logger.debug(`Validation result for ${fullPath}: ${isValid}`);
      if (!isValid) {
        continue;
      }

      const imported = await import(fullPath);

      if (typeof imported.registry !== "function") {
        continue;
      }
      logger.debug(`Registering route from file: ${fullPath}`);
      const relativeDir = path.relative(baseFolder, currentDir);

      logger.debug("Found prefix:", options?.prefix);
      const routePath =
        (options?.prefix ? options.prefix : "") +
        "/" +
        relativeDir.split(path.sep).filter(Boolean).join("/");
      logger.debug(`Computed route path for ${fullPath}: ${routePath}`);
      const router = Router();

      const routeMiddlewares = imported.middlewares || [];
      logger.debug(
        `Applying middlewares for ${routePath}: ${routeMiddlewares.length} middlewares found`,
      );
      app.use(routePath, ...globalMiddlewares, ...routeMiddlewares, router);

      await imported.registry(router);

      const rota = { path: routePath, endpoints: endpointsOf(router) };
      recordRoute(rota);
      AllRouters[routePath] = {
        ...rota,
        file: fullPath,
        globalMiddlewares: globalMiddlewares.length,
        routeMiddlewares: routeMiddlewares.length,
      };
      montadas.push(rota);
      logger.debug(`[ROUTE] ${routePath} (${rota.endpoints.length} endpoints)`);
    }
  }

  await scan(baseFolder);

  // Uma tabela por pasta varrida (web, api...), no lugar de uma linha por rota.
  for (const linha of formatRoutesTable(montadas)) logger.info(linha);
}

import fs from "fs/promises";
import path from "path";

import { Express, RequestHandler, Router } from "express";

import { validateRouteFile } from "./validate-route-file";

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
      console.log(`Found file: ${fullPath}, isIndexFile: ${isIndexFile}`);
      if (!isIndexFile) {
        continue;
      }

      const isValid = await validateRouteFile(fullPath);
      console.log(`Validation result for ${fullPath}: ${isValid}`);
      if (!isValid) {
        continue;
      }

      const imported = await import(fullPath);

      if (typeof imported.registry !== "function") {
        continue;
      }
      console.log(`Registering route from file: ${fullPath}`);
      const relativeDir = path.relative(baseFolder, currentDir);

      console.log("Found prefix:", options?.prefix);
      const routePath =
        (options?.prefix ? options.prefix : "") +
        "/" +
        relativeDir.split(path.sep).filter(Boolean).join("/");
      console.log(`Computed route path for ${fullPath}: ${routePath}`);
      const router = Router();

      const routeMiddlewares = imported.middlewares || [];
      console.log(
        `Applying middlewares for ${routePath}: ${routeMiddlewares.length} middlewares found`,
      );
      app.use(routePath, ...globalMiddlewares, ...routeMiddlewares, router);

      await imported.registry(router);

      console.log(`[ROUTE] ${routePath}`);
    }
  }

  await scan(baseFolder);
}

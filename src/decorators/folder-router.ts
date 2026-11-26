import fs from "fs/promises";
import path from "path";

import { Router } from "express";
import type { Express, RequestHandler } from "express";

import { logger } from "../functions/logger";
import { container as containerGlobal, type Container } from "./container";
import {
  endpointsOf,
  formatRoutesTable,
  recordRoute,
  type RegisteredRoute,
} from "./route-registry";
import { assertWithoutForbiddenPatterns, validateRouteFile } from "./validate-route-file";

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

export type FolderRouterOptions = {
  middlewares?: RequestHandler[];
  prefix?: string;
  /** Leva os params do caminho de montagem (`/academias/:academiaId`) para as rotas. */
  mergeParams?: boolean;
  /**
   * O container do app (`createContainer()`), entregue a cada `registry(router, { container })`
   * para o `container.get` dele. Default: o container global.
   */
  container?: Container;
};

/** O que o `folderRouter` entrega ao `registry(router, montagem)` de cada pasta. */
export interface RouteMount {
  container: Container;
}

/**
 * O arquivo de middlewares de uma pasta. O `middlewares` que ele exporta vale para a pasta e para
 * todas as de baixo, antes do `middlewares` de cada rota. Sem o export, não muda nada.
 */
const ARQUIVOS_DE_MIDDLEWARES_DA_PASTA = ["_middlewares.ts", "_middlewares.js"];

const isArquivo = (caminho: string) =>
  fs.stat(caminho).then(
    (stat) => stat.isFile(),
    () => false,
  );

/** Os middlewares que a pasta declara no `_middlewares` dela; nenhum quando não há. */
async function readMiddlewaresDaPasta(pasta: string): Promise<RequestHandler[]> {
  for (const nome of ARQUIVOS_DE_MIDDLEWARES_DA_PASTA) {
    const arquivo = path.join(pasta, nome);
    if (!(await isArquivo(arquivo))) continue;
    assertWithoutForbiddenPatterns(await fs.readFile(arquivo, "utf-8"), arquivo);
    const { middlewares } = await import(arquivo);
    return Array.isArray(middlewares) ? middlewares : [];
  }
  return [];
}

/** O mesmo handler em mais de um nível (global, pasta, rota) roda uma vez, na primeira posição. */
const withoutRepetidos = (handlers: RequestHandler[]) => [...new Set(handlers)];

export async function folderRouter(
  app: Express,
  baseFolder: string,
  options?: FolderRouterOptions,
) {
  const globalMiddlewares = options?.middlewares || [];
  const montadas: RegisteredRoute[] = [];

  /** `herdados`: os `_middlewares` das pastas de cima, da raiz para a atual. */
  async function scan(currentDir: string, herdados: RequestHandler[]) {
    const daPasta = [...herdados, ...(await readMiddlewaresDaPasta(currentDir))];
    const entries = await fs.readdir(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath, daPasta);

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
      const router = Router({ mergeParams: options?.mergeParams === true });

      const routeMiddlewares = imported.middlewares || [];
      // A rota que não pode herdar (upload multipart, antes do multer) declara a saída.
      const herdaveis = imported.inheritFolderMiddlewares === false ? [] : daPasta;
      const aplicados = withoutRepetidos([...globalMiddlewares, ...herdaveis, ...routeMiddlewares]);
      logger.debug(`Applying middlewares for ${routePath}: ${aplicados.length} middlewares found`);
      app.use(routePath, ...aplicados, router);

      const montagem: RouteMount = { container: options?.container ?? containerGlobal };
      await imported.registry(router, montagem);

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

  await scan(baseFolder, []);

  // Uma tabela por pasta varrida (web, api...), no lugar de uma linha por rota.
  for (const linha of formatRoutesTable(montadas)) logger.info(linha);
}

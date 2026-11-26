import "reflect-metadata";
import type { RequestHandler } from "express";

import { logger } from "../functions/logger";
import { appendMetadataItem } from "./_metadataList";
import type { Container } from "./container";
import { ROUTERS_KEY } from "./router-metadata";

export type RegistryRouterOptions = {
  folder: string;
  middlewares?: RequestHandler[];
  prefix?: string;
  /** Leva os params do prefixo (`/academias/:academiaId`) para as rotas da pasta. */
  mergeParams?: boolean;
  /** O container do app, entregue ao `registry(router, { container })` de cada pasta. */
  container?: Container;
};

export function RegistryRouter(options: RegistryRouterOptions) {
  return function (target: any, propertyKey: string) {
    logger.debug(`Registering router for method: ${propertyKey}, folder: ${options.folder}`);
    const routes = appendMetadataItem(ROUTERS_KEY, target, {
      methodName: propertyKey,
      folder: options.folder,
      middlewares: options.middlewares || [],
      prefix: options.prefix || "",
      mergeParams: options.mergeParams === true,
      container: options.container,
    });
    logger.debug(`Registered routes after adding: ${routes.length}`);
  };
}

import "reflect-metadata";

import type { RequestHandler } from "express";

import { ROUTERS_KEY } from "./router-metadata";

export type RegistryRouterOptions = {
  folder: string;
  middlewares?: RequestHandler[];
  prefix?: string;
};

export function RegistryRouter(options: RegistryRouterOptions) {
  return function (target: any, propertyKey: string) {
    const currentRoutes = Reflect.getMetadata(ROUTERS_KEY, target) || [];
    console.log(`Registering router for method: ${propertyKey}, folder: ${options.folder}`);
    console.log(`Current registered routes before adding: ${currentRoutes.length}`);
    currentRoutes.push({
      methodName: propertyKey,
      folder: options.folder,
      middlewares: options.middlewares || [],
      prefix: options.prefix || "",
    });

    Reflect.defineMetadata(ROUTERS_KEY, currentRoutes, target);
  };
}

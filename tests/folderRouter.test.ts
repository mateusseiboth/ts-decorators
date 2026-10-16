import { afterEach, describe, expect, test } from "bun:test";

import express from "express";

/**
 * `folderRouter` monta cada `index.ts` da pasta e publica a rota em DOIS lugares: o registro com
 * os endpoints (`getRegisteredRoutes`, base do health check) e o `AllRouters`, que o projeto lê
 * por caminho de montagem. Sem banco e sem rede: só o Express em memória.
 */
import { AllRouters, folderRouter } from "../src/decorators/folder-router";
import { clearRegisteredRoutes, getRegisteredRoutes } from "../src/decorators/route-registry";

const PASTA = `${import.meta.dir}/fixtures/routes`;

describe("folderRouter", () => {
  afterEach(() => {
    clearRegisteredRoutes();
    for (const chave of Object.keys(AllRouters)) delete AllRouters[chave];
  });

  test("AllRouters guarda a rota montada pelo caminho, com arquivo e middlewares", async () => {
    const global: express.RequestHandler = (_req, _res, next) => next();
    await folderRouter(express(), PASTA, { prefix: "/api", middlewares: [global] });

    expect(AllRouters["/api/banco"]).toEqual({
      path: "/api/banco",
      file: `${PASTA}/banco/index.ts`,
      globalMiddlewares: 1,
      routeMiddlewares: 1,
      endpoints: [
        { method: "GET", path: "/" },
        { method: "POST", path: "/" },
      ],
    });
  });

  test("a mesma rota entra no registro de rotas", async () => {
    await folderRouter(express(), PASTA);

    expect(getRegisteredRoutes()).toEqual([
      {
        path: "/banco",
        endpoints: [
          { method: "GET", path: "/" },
          { method: "POST", path: "/" },
        ],
      },
    ]);
  });
});

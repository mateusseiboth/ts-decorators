import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import express from "express";

import { container, createContainer } from "../src/decorators/container";
import { AllRouters, folderRouter } from "../src/decorators/folder-router";
import { GlobalRouter, GlobalRouterApp } from "../src/decorators/global-router";
import { applyControllerRoutes, Get, listRouteDefinitions } from "../src/decorators/http-methods";
import { RegistryRouter } from "../src/decorators/registry-router";
import { Rest } from "../src/decorators/rest";
import { clearRegisteredRoutes } from "../src/decorators/route-registry";
import { RouteBuilder } from "../src/decorators/router-builder";
import { recebidos } from "./fixtures/routesContainer/planos/index";

const PASTA = `${import.meta.dir}/fixtures/routesContainer`;

const listen = async (app: express.Express) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
};

beforeEach(() => {
  recebidos.length = 0;
});
afterEach(() => {
  clearRegisteredRoutes();
  for (const chave of Object.keys(AllRouters)) delete AllRouters[chave];
});

describe("folderRouter: container da montagem", () => {
  test("o registry recebe o container passado na montagem", async () => {
    const doApp = createContainer();
    await folderRouter(express(), PASTA, { container: doApp });
    expect(recebidos).toEqual([{ container: doApp }]);
  });

  test("sem container, o registry recebe o global", async () => {
    await folderRouter(express(), PASTA);
    expect(recebidos).toEqual([{ container }]);
  });

  test("@RegistryRouter repassa o container", async () => {
    const doApp = createContainer();
    @GlobalRouter()
    class Servidor extends GlobalRouterApp {
      app = express();
      @RegistryRouter({ folder: PASTA, container: doApp })
      rotas() {}
    }
    await new Servidor().initializeRoutes();
    expect(recebidos).toEqual([{ container: doApp }]);
  });
});

describe("RouteBuilder: respond e registro das rotas declaradas", () => {
  const buildApp = (respond: any) => {
    const app = express();
    const router = express.Router();
    const route = new RouteBuilder(router, [], { respond });
    app.use(router);
    return { app, route };
  };

  test("o respond do builder responde com o retorno da rota declarada", async () => {
    const { app, route } = buildApp((result: unknown, _req: any, res: any) =>
      res.json({ data: result }),
    );
    route.get("/planos", async () => [{ id: 1 }]);
    const servidor = await listen(app);
    try {
      expect(await (await fetch(`${servidor.base}/planos`)).json()).toEqual({ data: [{ id: 1 }] });
    } finally {
      servidor.close();
    }
  });

  test("resultado undefined também passa pelo respond: o projeto decide o 204", async () => {
    const vistos: unknown[] = [];
    const { app, route } = buildApp((result: unknown, _req: any, res: any) => {
      vistos.push(result);
      res.status(204).end();
    });
    route.delete("/planos/:id", async () => undefined);
    const servidor = await listen(app);
    try {
      const resposta = await fetch(`${servidor.base}/planos/1`, { method: "DELETE" });
      expect(resposta.status).toBe(204);
      expect(vistos).toEqual([undefined]);
    } finally {
      servidor.close();
    }
  });

  test("rota que chamou next não passa pelo respond", async () => {
    let chamadas = 0;
    const { app, route } = buildApp(() => {
      chamadas += 1;
    });
    route.get("/passa", (_req, _res, next) => next());
    app.use((_req, res) => res.status(418).end());
    const servidor = await listen(app);
    try {
      expect((await fetch(`${servidor.base}/passa`)).status).toBe(418);
      expect(chamadas).toBe(0);
    } finally {
      servidor.close();
    }
  });

  test("o extend leva o respond e o registro junto", async () => {
    const { app, route } = buildApp((result: unknown, _req: any, res: any) =>
      res.json({ data: result }),
    );
    const autenticado = route.extend([(_req, _res, next) => next()]);
    autenticado.get("/eu", { doc: { summary: "Quem sou eu" } }, async () => ({ nome: "Ana" }));
    const servidor = await listen(app);
    try {
      expect(await (await fetch(`${servidor.base}/eu`)).json()).toEqual({ data: { nome: "Ana" } });
    } finally {
      servidor.close();
    }
    expect(route.definitions().map((d) => [d.method, d.path, d.options.doc])).toEqual([
      ["get", "/eu", { summary: "Quem sou eu" }],
    ]);
  });
});

describe("listRouteDefinitions com o declareRoutes", () => {
  class PlanoController {
    async get() {
      return [];
    }
    async getById() {
      return {};
    }
    @Get("/:id/historico", { doc: { summary: "Histórico" } })
    async historico() {
      return [];
    }
  }

  @Rest({ only: ["list", "get"] })
  class PlanoRegistry {
    route: RouteBuilder;
    constructor(
      readonly controller: PlanoController,
      router = express.Router(),
    ) {
      this.route = new RouteBuilder(router);
    }
    declareRoutes() {
      this.route.post("/:id/ativar", { doc: { summary: "Ativa o plano" } }, async () => ({
        ok: true,
      }));
    }
    configure() {
      applyControllerRoutes({
        controller: this.controller,
        routes: listRouteDefinitions(this),
        resolveBuilder: () => this.route,
      });
      this.declareRoutes();
    }
  }

  test("junta o @Rest, os verbos do controller e as rotas declaradas, sem repetir", () => {
    const registry = new PlanoRegistry(new PlanoController());
    registry.configure();
    expect(listRouteDefinitions(registry).map((r) => [r.method, r.path])).toEqual([
      ["get", "/"],
      ["get", "/:id"],
      ["get", "/:id/historico"],
      ["post", "/:id/ativar"],
    ]);
    expect(listRouteDefinitions(registry)[3]?.options.doc).toEqual({ summary: "Ativa o plano" });
  });
});

describe("applyControllerRoutes: respond com undefined", () => {
  class Controller {
    @Get("/:id")
    async remover() {
      return undefined;
    }
  }

  test("roda o respond quando ninguém respondeu, mesmo com undefined", async () => {
    const app = express();
    const router = express.Router();
    const builder = new RouteBuilder(router);
    applyControllerRoutes({
      controller: new Controller(),
      resolveBuilder: () => builder,
      respond: (_result, _req, res) => res.status(204).end(),
    });
    app.use(router);
    const servidor = await listen(app);
    try {
      expect((await fetch(`${servidor.base}/1`)).status).toBe(204);
    } finally {
      servidor.close();
    }
  });
});

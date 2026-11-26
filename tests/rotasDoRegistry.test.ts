import "reflect-metadata";
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import express from "express";

import { setLegacyWarnings, warnLegacy } from "../src/decorators/_proxy";
import { AllRouters, folderRouter } from "../src/decorators/folder-router";
import { GlobalRouter, type GlobalRouterHost } from "../src/decorators/global-router";
import {
  applyControllerRoutes,
  Get,
  listRouteDefinitions,
  Post,
} from "../src/decorators/http-methods";
import { RegistryRouter } from "../src/decorators/registry-router";
import { Rest } from "../src/decorators/rest";
import { clearRegisteredRoutes } from "../src/decorators/route-registry";
import { RouteBuilder } from "../src/decorators/router-builder";
import { setTransactionalCompanyFn, Transactional } from "../src/decorators/transactional";
import { setHandlerContext } from "../src/handlers/context";
import { configureTenantGucs, resetTenantGucs } from "../src/handlers/tenantGucs";
import { captureWarnings } from "./_helpers";

const PASTA = `${import.meta.dir}/fixtures/routesParams`;

const listen = async (app: express.Express) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
};

afterEach(() => {
  clearRegisteredRoutes();
  for (const chave of Object.keys(AllRouters)) delete AllRouters[chave];
});

describe("folderRouter: mergeParams", () => {
  test("com mergeParams, o param do prefixo chega à rota", async () => {
    const app = express();
    await folderRouter(app, PASTA, { prefix: "/academias/:academiaId", mergeParams: true });
    const servidor = await listen(app);
    try {
      const resposta = await fetch(`${servidor.base}/academias/a-9/alunos`);
      expect(await resposta.json()).toEqual({ academiaId: "a-9" });
    } finally {
      servidor.close();
    }
  });

  test("sem mergeParams, fica como antes", async () => {
    const app = express();
    await folderRouter(app, PASTA, { prefix: "/academias/:academiaId" });
    const servidor = await listen(app);
    try {
      const resposta = await fetch(`${servidor.base}/academias/a-9/alunos`);
      expect(await resposta.json()).toEqual({});
    } finally {
      servidor.close();
    }
  });

  test("@RegistryRouter e @GlobalRouter repassam o mergeParams", async () => {
    @GlobalRouter()
    class Servidor {
      app = express();
      @RegistryRouter({ folder: PASTA, prefix: "/academias/:academiaId", mergeParams: true })
      rotas() {}
    }
    // O tipo do decorator não muda a classe: a interface declara o que ele acrescenta.
    const servidor = new Servidor() as Servidor & GlobalRouterHost;
    await servidor.initializeRoutes();
    const http = await listen(servidor.app);
    try {
      const resposta = await fetch(`${http.base}/academias/b-1/alunos`);
      expect(await resposta.json()).toEqual({ academiaId: "b-1" });
    } finally {
      http.close();
    }
  });
});

describe("applyControllerRoutes: respond com o retorno do método", () => {
  class AlunoController {
    @Get("/:id", { doc: { summary: "Aluno pelo id", tags: ["alunos"] } })
    async getById(req: any) {
      return { id: req.params.id };
    }

    @Post("/")
    async create(_req: any, res: any) {
      res.status(201).json({ criado: true });
    }
  }

  const buildApp = (respond?: (result: unknown, req: any, res: any) => unknown, wrap?: any) => {
    const app = express();
    const router = express.Router();
    const builder = new RouteBuilder(router);
    applyControllerRoutes({
      controller: new AlunoController(),
      resolveBuilder: () => builder,
      respond: respond as any,
      wrap,
    });
    app.use(router);
    return app;
  };

  test("o respond recebe o retorno e responde", async () => {
    const app = buildApp((result, _req, res) => res.json({ data: result }));
    const servidor = await listen(app);
    try {
      const resposta = await fetch(`${servidor.base}/7`);
      expect(await resposta.json()).toEqual({ data: { id: "7" } });
    } finally {
      servidor.close();
    }
  });

  test("o respond roda depois do wrap terminar (depois do commit)", async () => {
    const ordem: string[] = [];
    const wrap =
      (_def: unknown, invoke: express.RequestHandler) => async (req: any, res: any, next: any) => {
        const result = await invoke(req, res, next);
        ordem.push("commit");
        return result;
      };
    const app = buildApp((result, _req, res) => {
      ordem.push("respond");
      res.json(result);
    }, wrap);
    const servidor = await listen(app);
    try {
      await fetch(`${servidor.base}/1`);
      expect(ordem).toEqual(["commit", "respond"]);
    } finally {
      servidor.close();
    }
  });

  test("método que já respondeu não passa pelo respond", async () => {
    let chamadas = 0;
    const app = buildApp(() => {
      chamadas += 1;
    });
    const servidor = await listen(app);
    try {
      const resposta = await fetch(`${servidor.base}/`, { method: "POST" });
      expect(resposta.status).toBe(201);
      expect(chamadas).toBe(0);
    } finally {
      servidor.close();
    }
  });
});

describe("listRouteDefinitions", () => {
  class LoteController {
    async get() {}
    async getById() {}
    @Post("/:id/baixa", { doc: { summary: "Baixa o lote" } })
    async baixar() {}
  }

  @Rest({ only: ["list", "get"] })
  class LoteRegistry {
    constructor(readonly controller: LoteController) {}
  }

  test("junta o @Rest do registry e os verbos do controller, com as opções de doc", () => {
    const rotas = listRouteDefinitions(new LoteRegistry(new LoteController()));
    expect(rotas.map((r) => [r.method, r.path, r.handlerName])).toEqual([
      ["get", "/", "get"],
      ["get", "/:id", "getById"],
      ["post", "/:id/baixa", "baixar"],
    ]);
    expect(rotas[2]?.options.doc).toEqual({ summary: "Baixa o lote" });
  });
});

describe("RouteBuilder protegido e extensível", () => {
  class RotasDoProjeto extends RouteBuilder {
    withAuth() {
      return this.extend([(_req, _res, next) => next()]);
    }
    get quantos() {
      return this.defaultMiddlewares.length;
    }
  }

  test("a subclasse lê router e defaultMiddlewares, e o extend devolve a subclasse", () => {
    const builder = new RotasDoProjeto(express.Router()).withAuth();
    expect(builder).toBeInstanceOf(RotasDoProjeto);
    expect((builder as RotasDoProjeto).quantos).toBe(1);
  });
});

describe("aviso de decorator legado", () => {
  afterEach(() => setLegacyWarnings(true));

  test("setLegacyWarnings(false) cala o aviso no projeto que usa o modo legado", () => {
    const cap = captureWarnings();
    try {
      setLegacyWarnings(false);
      warnLegacy("DecoratorQualquerDoTeste");
      expect(cap.warnings.some((w) => w.includes("DecoratorQualquerDoTeste"))).toBe(false);
    } finally {
      cap.restore();
    }
  });
});

describe("Transactional (middleware) com as GUCs ligadas", () => {
  afterEach(() => {
    resetTenantGucs();
    setHandlerContext(() => undefined);
  });

  test("injeta as GUCs mesmo sem res.locals.entity (super admin)", async () => {
    setTransactionalCompanyFn(null);
    setHandlerContext(() => ({ superAdmin: true }));
    configureTenantGucs((ctx) => ({ "app.is_super_admin": ctx?.superAdmin === true }));
    const calls: unknown[][] = [];
    const tx = {
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        calls.push([sql, ...params]);
      },
    };
    const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
    const res: any = Object.assign(new EventEmitter(), {
      locals: {},
      statusCode: 200,
      headersSent: false,
    });

    await new Promise<void>((resolve) => {
      Transactional(prisma as any)({} as any, res, () => {
        res.emit("finish");
        resolve();
      });
    });

    expect(calls[0]?.slice(1)).toEqual(["app.is_super_admin", "true"]);
  });
});

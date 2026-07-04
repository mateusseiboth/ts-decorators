import {describe, expect, test} from "bun:test";
import type {RequestHandler} from "express";
import {
  All,
  Delete,
  Get,
  Patch,
  Post,
  Put,
  applyControllerRoutes,
  getControllerRoutes,
  type RouteDefinition,
} from "../src/decorators/http-methods";

describe("HTTP method decorators", () => {
  test("registra verbo, path e options na metadata", () => {
    class Ctrl {
      @Get(":id/carne", {action: "GET"})
      getById() {}

      @Post("/", {action: "CREATE", use: "routeWithExtra"})
      create() {}
    }

    const routes = getControllerRoutes(Ctrl);
    expect(routes).toHaveLength(2);

    const get = routes.find((r) => r.method === "get")!;
    expect(get.path).toBe(":id/carne");
    expect(get.handlerName).toBe("getById");
    expect(get.options.action).toBe("GET");

    const post = routes.find((r) => r.method === "post")!;
    expect(post.options.use).toBe("routeWithExtra");
  });

  test("herda rotas de uma classe base e subclasse tem precedência", () => {
    class Base {
      @Get("/:id", {action: "GET"})
      getById() {}
    }
    class Child extends Base {
      @Post("/", {action: "CREATE"})
      create() {}
    }

    const routes = getControllerRoutes(Child);
    const methods = routes.map((r) => r.method).sort();
    expect(methods).toEqual(["get", "post"]);
  });

  test("cobre todos os verbos", () => {
    class Ctrl {
      @Get("/") g() {}
      @Post("/") p() {}
      @Put("/") u() {}
      @Patch("/") pa() {}
      @Delete("/") d() {}
      @All("/") a() {}
    }
    const verbs = getControllerRoutes(Ctrl)
      .map((r) => r.method)
      .sort();
    expect(verbs).toEqual(["all", "delete", "get", "patch", "post", "put"]);
  });

  test("applyControllerRoutes registra no builder resolvido e aplica o wrap", () => {
    const calls: Array<{method: string; path: string; handlers: RequestHandler[]}> = [];
    const makeBuilder = (label: string) =>
      new Proxy(
        {},
        {
          get: (_t, method: string) => (path: string, ...handlers: RequestHandler[]) => {
            calls.push({method: `${label}:${method}`, path, handlers});
          },
        },
      ) as any;

    const plain = makeBuilder("plain");
    const paginate = makeBuilder("paginate");

    class Ctrl {
      @Get("/", {use: "routeWithPaginate", action: "LIST"})
      list() {}
      @Post("/:id", {action: "CREATE"})
      create() {}
    }

    const wrapped: RouteDefinition[] = [];
    applyControllerRoutes({
      controller: new Ctrl(),
      resolveBuilder: (use) => (use === "routeWithPaginate" ? paginate : plain),
      wrap: (def, invoke) => {
        wrapped.push(def);
        return invoke;
      },
    });

    expect(wrapped).toHaveLength(2);
    expect(calls.find((c) => c.method === "paginate:get")?.path).toBe("/");
    expect(calls.find((c) => c.method === "plain:post")?.path).toBe("/:id");
  });

  test("wrap é opcional — chama o método do controller direto", async () => {
    let called = false;
    const captured: RequestHandler[] = [];
    const builder = new Proxy(
      {},
      {
        get: () => (_path: string, ...handlers: RequestHandler[]) => captured.push(...handlers),
      },
    ) as any;

    class Ctrl {
      @Get("/")
      get() {
        called = true;
      }
    }

    applyControllerRoutes({
      controller: new Ctrl(),
      resolveBuilder: () => builder,
    });

    captured[0]!({} as any, {} as any, (() => {}) as any);
    expect(called).toBe(true);
  });
});

import {describe, expect, test} from "bun:test";
import type {RequestHandler} from "express";
import {applyControllerRoutes} from "../src/decorators/http-methods";
import {REST_PRESET, Rest, getRestRoutes} from "../src/decorators/rest";

function makeRecorder() {
  const calls: Array<{label: string; method: string; path: string}> = [];
  const builder = (label: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => (path: string, ..._h: RequestHandler[]) => {
          calls.push({label, method, path});
        },
      },
    ) as any;
  return {calls, builder};
}

describe("@Rest — CRUD declarativo", () => {
  test("gera o preset completo por padrão", () => {
    @Rest()
    class Registry {}

    const routes = getRestRoutes(Registry);
    expect(routes).toHaveLength(5);

    const list = routes.find((r) => r.handlerName === "get")!;
    expect(list.method).toBe("get");
    expect(list.path).toBe("/");
    expect(list.options.use).toBe("routeWithPaginate");
    expect(list.options.action).toBe("LIST");

    const del = routes.find((r) => r.handlerName === "deleteById")!;
    expect(del.options.use).toBe("routeWithIdempotency");
  });

  test("only restringe as ações", () => {
    @Rest({only: ["list", "get"]})
    class Registry {}
    const names = getRestRoutes(Registry)
      .map((r) => r.handlerName)
      .sort();
    expect(names).toEqual(["get", "getById"]);
  });

  test("except remove ações", () => {
    @Rest({except: ["delete", "update"]})
    class Registry {}
    const names = getRestRoutes(Registry).map((r) => r.handlerName);
    expect(names).not.toContain("deleteById");
    expect(names).not.toContain("update");
    expect(names).toHaveLength(3);
  });

  test("overrides customizam path/use/options", () => {
    @Rest({
      overrides: {
        list: {use: "routeSpecial", path: "/todos", options: {action: "LISTAR"}},
      },
    })
    class Registry {}

    const list = getRestRoutes(Registry).find((r) => r.handlerName === "get")!;
    expect(list.path).toBe("/todos");
    expect(list.options.use).toBe("routeSpecial");
    expect(list.options.action).toBe("LISTAR");
  });

  test("sem @Rest retorna vazio", () => {
    class Registry {}
    expect(getRestRoutes(Registry)).toEqual([]);
  });

  test("integra com applyControllerRoutes resolvendo builders por nome", () => {
    const {calls, builder} = makeRecorder();
    const route = builder("route");
    const routeWithPaginate = builder("paginate");
    const routeWithExtraInfo = builder("extra");
    const routeWithIdempotency = builder("idem");
    const map: Record<string, any> = {route, routeWithPaginate, routeWithExtraInfo, routeWithIdempotency};

    class Controller {
      get() {}
      getById() {}
      create() {}
      update() {}
      deleteById() {}
    }

    @Rest()
    class Registry {}

    applyControllerRoutes({
      controller: new Controller(),
      routes: getRestRoutes(Registry),
      resolveBuilder: (use) => map[use ?? "route"],
    });

    expect(calls).toContainEqual({label: "paginate", method: "get", path: "/"});
    expect(calls).toContainEqual({label: "idem", method: "delete", path: "/:id"});
    expect(calls).toContainEqual({label: "extra", method: "post", path: "/"});
  });

  test("ignora ação cujo handler não existe no controller", () => {
    const {calls, builder} = makeRecorder();
    const b = builder("b");

    class Controller {
      get() {}
      getById() {}
      // sem create/update/deleteById
    }

    @Rest()
    class Registry {}

    applyControllerRoutes({
      controller: new Controller(),
      routes: getRestRoutes(Registry),
      resolveBuilder: () => b,
    });

    const paths = calls.map((c) => `${c.method} ${c.path}`).sort();
    expect(paths).toEqual(["get /", "get /:id"]);
  });

  test("options.build transforma o builder só daquela rota", () => {
    let built = false;
    const transformed = new Proxy(
      {},
      {get: () => (_p: string) => {}},
    ) as any;
    const base = new Proxy(
      {},
      {get: () => (_p: string) => {}},
    ) as any;

    @Rest({
      overrides: {
        list: {
          options: {
            build: (b) => {
              built = b === base;
              return transformed;
            },
          },
        },
      },
    })
    class Registry {}

    class Controller {
      get() {}
    }

    applyControllerRoutes({
      controller: new Controller(),
      routes: getRestRoutes(Registry).filter((r) => r.handlerName === "get"),
      resolveBuilder: () => base,
    });

    expect(built).toBe(true);
  });

  test("REST_PRESET é a fonte de verdade do mapeamento", () => {
    expect(REST_PRESET.list.use).toBe("routeWithPaginate");
    expect(REST_PRESET.create.use).toBe("routeWithExtraInfo");
    expect(REST_PRESET.get.use).toBe("route");
  });
});

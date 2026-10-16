import { afterEach, describe, expect, test } from "bun:test";

import { Router } from "express";

/**
 * Rotas montadas pelo folderRouter: guardadas num registro (o health check do sistema lê daqui) e
 * impressas no boot numa tabela única, no lugar de uma linha `[ROUTE]` por pasta.
 */
import {
  clearRegisteredRoutes,
  endpointsOf,
  formatRoutesTable,
  getRegisteredRoutes,
  recordRoute,
} from "../src/decorators/route-registry";

describe("endpointsOf", () => {
  test("lê verbo e caminho de cada rota do router", () => {
    const router = Router();
    router.get("/", () => {});
    router.post("/", () => {});
    router.get("/:id", () => {});
    router.put("/:id", () => {});
    router.use(() => {}); // middleware sem rota não é endpoint

    expect(endpointsOf(router)).toEqual([
      { method: "GET", path: "/" },
      { method: "POST", path: "/" },
      { method: "GET", path: "/:id" },
      { method: "PUT", path: "/:id" },
    ]);
  });

  test("rota com vários verbos e .all()", () => {
    const router = Router();
    router
      .route("/x")
      .get(() => {})
      .delete(() => {});
    router.all("/y", () => {});

    expect(endpointsOf(router)).toEqual([
      { method: "GET", path: "/x" },
      { method: "DELETE", path: "/x" },
      { method: "ALL", path: "/y" },
    ]);
  });
});

describe("registro de rotas", () => {
  afterEach(() => clearRegisteredRoutes());

  test("guarda na ordem em que foram montadas", () => {
    recordRoute({ path: "/api/v1/banco", endpoints: [{ method: "GET", path: "/" }] });
    recordRoute({ path: "/api/v1/cnae", endpoints: [] });

    expect(getRegisteredRoutes().map((rota) => rota.path)).toEqual([
      "/api/v1/banco",
      "/api/v1/cnae",
    ]);
  });
});

describe("formatRoutesTable", () => {
  const rotas = [
    {
      path: "/api/v1/cobranca/baixa",
      endpoints: [
        { method: "POST", path: "/" },
        { method: "GET", path: "/" },
        { method: "GET", path: "/:id" },
      ],
    },
    { path: "/api/v1/cnae", endpoints: [{ method: "DELETE", path: "/:id" }] },
  ];

  test("tabela com rota, quantidade de endpoints e verbos em ordem fixa", () => {
    expect(formatRoutesTable(rotas)).toEqual([
      "┌────────────────────────┬─────┬─────────────┐",
      "│ Rota                   │ End │ Verbos      │",
      "├────────────────────────┼─────┼─────────────┤",
      "│ /api/v1/cobranca/baixa │   3 │ GET POST    │",
      "│ /api/v1/cnae           │   1 │ DELETE      │",
      "├────────────────────────┼─────┼─────────────┤",
      "│ 2 rotas                │   4 │             │",
      "└────────────────────────┴─────┴─────────────┘",
    ]);
  });

  test("sem rota, sem tabela", () => {
    expect(formatRoutesTable([])).toEqual([]);
  });
});

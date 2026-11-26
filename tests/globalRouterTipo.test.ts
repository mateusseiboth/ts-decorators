import { describe, expect, test } from "bun:test";

import { GlobalRouter, GlobalRouterApp } from "../src/decorators/global-router";

// A base declara o initializeRoutes que o decorator acrescenta: sem cast no projeto.
@GlobalRouter()
class Servidor extends GlobalRouterApp {
  app = { use: () => undefined } as any;
}

describe("@GlobalRouter: tipo", () => {
  test("initializeRoutes existe na instância", async () => {
    const servidor = new Servidor();
    expect(typeof servidor.initializeRoutes).toBe("function");
    await servidor.initializeRoutes();
  });
});

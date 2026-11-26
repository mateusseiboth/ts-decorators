import { afterEach, describe, expect, test } from "bun:test";

import { ModelTagged } from "../src/decorators/getModel";
import { Field, InitFields } from "../src/decorators/initFields";
import { RouteBuilder } from "../src/decorators/router-builder";
import { getOrderBy } from "../src/middlwares/getOrderBy";
import { createPaginate } from "../src/middlwares/getPaginate";
import { mockNext, mockReq, mockRes } from "./_helpers";
import { BairroModel, SimpleModel } from "./_models";

// Model sem `id`: o desempate não inventa coluna.
@InitFields
@ModelTagged
class UserModelWithoutId {
  static tag = 99101;
  @Field() nome!: string;
  static getModel() {
    return new UserModelWithoutId();
  }
}

describe("createPaginate", () => {
  test("required: sem o cabeçalho, pagina com o padrão em vez de devolver a lista inteira", () => {
    const res = mockRes();
    const next = mockNext();
    createPaginate({ required: true, defaultOffset: 20 })(mockReq(), res, next);
    expect(next.called).toBe(true);
    expect(res.locals.paginate).toEqual({ skip: 0, take: 20, page: 1 });
  });

  test("o padrão configurado vale quando o cabeçalho offset não vem", () => {
    const res = mockRes();
    createPaginate({ defaultOffset: 25 })(
      mockReq({ headers: { paginate: "true", page: "3" } }),
      res,
      mockNext(),
    );
    expect(res.locals.paginate).toEqual({ skip: 50, take: 25, page: 3 });
  });

  test("offset acima do máximo responde 400 no campo offset", () => {
    const res = mockRes();
    const next = mockNext();
    createPaginate({ maxOffset: 100 })(
      mockReq({ headers: { paginate: "true", offset: "101" } }),
      res,
      next,
    );
    expect(next.called).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res._body.errors).toEqual([
      { path: "offset", message: "Quantidade por página acima do máximo de 100." },
    ]);
  });

  test("offset no máximo passa", () => {
    const res = mockRes();
    createPaginate({ maxOffset: 100 })(
      mockReq({ headers: { paginate: "true", offset: "100" } }),
      res,
      mockNext(),
    );
    expect(res.locals.paginate).toEqual({ skip: 0, take: 100, page: 1 });
  });

  test("sem required e sem cabeçalho, segue sem paginar (o comportamento do getPaginate)", () => {
    const res = mockRes();
    const next = mockNext();
    createPaginate({ maxOffset: 100 })(mockReq(), res, next);
    expect(next.called).toBe(true);
    expect(res.locals.paginate).toBeUndefined();
  });

  test("padrão acima do máximo é erro de configuração", () => {
    expect(() => createPaginate({ defaultOffset: 200, maxOffset: 100 })).toThrow("defaultOffset");
  });
});

describe("RouteBuilder.withPrismaOptions: paginação por model e por rota", () => {
  const captureHandlers = () => {
    const registrados: Record<string, unknown[]> = {};
    const router = {
      get: (path: string, ...handlers: unknown[]) => {
        registrados[path] = handlers;
      },
    };
    return { router: router as any, registrados };
  };

  const runAll = (handlers: unknown[], req: any, res: any) => {
    for (const handler of handlers as Array<(req: any, res: any, next: () => void) => void>) {
      let seguiu = false;
      handler(req, res, () => {
        seguiu = true;
      });
      if (!seguiu) return;
    }
  };

  afterEach(() => {
    delete (BairroModel as any).paginate;
  });

  test("static paginate do model liga a paginação obrigatória", () => {
    (BairroModel as any).paginate = { required: true, defaultOffset: 15, maxOffset: 50 };
    const { router, registrados } = captureHandlers();
    new RouteBuilder(router).withPrismaOptions(BairroModel).get("/", () => undefined);
    const res = mockRes();
    runAll(registrados["/"]!, mockReq(), res);
    expect(res.locals.paginate).toEqual({ skip: 0, take: 15, page: 1 });
  });

  test("a opção da rota vence a do model", () => {
    (BairroModel as any).paginate = { required: true, defaultOffset: 15 };
    const { router, registrados } = captureHandlers();
    new RouteBuilder(router)
      .withPrismaOptions(BairroModel, { paginate: { required: true, defaultOffset: 5 } })
      .get("/", () => undefined);
    const res = mockRes();
    runAll(registrados["/"]!, mockReq(), res);
    expect(res.locals.paginate).toEqual({ skip: 0, take: 5, page: 1 });
  });
});

describe("getOrderBy: o id desempata sempre", () => {
  test("a ordem pedida ganha o id no fim", () => {
    const res = mockRes();
    getOrderBy(
      mockReq({ query: { orderBy: "name", orderMethod: "desc" } }),
      res,
      mockNext(),
      SimpleModel,
    );
    expect(res.locals.orderBy).toEqual([{ name: "desc" }, { id: "asc" }]);
  });

  test("sem ordem pedida, ordena pelo id", () => {
    const res = mockRes();
    const next = mockNext();
    getOrderBy(mockReq(), res, next, SimpleModel);
    expect(next.called).toBe(true);
    expect(res.locals.orderBy).toEqual([{ id: "asc" }]);
  });

  test("ordem pelo próprio id não repete o id", () => {
    const res = mockRes();
    getOrderBy(
      mockReq({ query: { orderBy: "id", orderMethod: "desc" } }),
      res,
      mockNext(),
      SimpleModel,
    );
    expect(res.locals.orderBy).toEqual([{ id: "desc" }]);
  });

  test("model sem campo id fica como antes", () => {
    const res = mockRes();
    getOrderBy(mockReq(), res, mockNext(), UserModelWithoutId);
    expect(res.locals.orderBy).toBeUndefined();
  });

  test("static orderTieBreaker troca a coluna do desempate", () => {
    (SimpleModel as any).orderTieBreaker = "name";
    try {
      const res = mockRes();
      getOrderBy(
        mockReq({ query: { orderBy: "age", orderMethod: "asc" } }),
        res,
        mockNext(),
        SimpleModel,
      );
      expect(res.locals.orderBy).toEqual([{ age: "asc" }, { name: "asc" }]);
    } finally {
      delete (SimpleModel as any).orderTieBreaker;
    }
  });

  test("static orderTieBreaker = false desliga o desempate", () => {
    (SimpleModel as any).orderTieBreaker = false;
    try {
      const res = mockRes();
      getOrderBy(mockReq(), res, mockNext(), SimpleModel);
      expect(res.locals.orderBy).toBeUndefined();
    } finally {
      delete (SimpleModel as any).orderTieBreaker;
    }
  });
});

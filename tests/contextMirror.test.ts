import { afterEach, describe, expect, test } from "bun:test";

import { setHandlerContext } from "../src/handlers/context";
import { getColumns } from "../src/middlwares/getColumns";
import { getOrderBy } from "../src/middlwares/getOrderBy";
import { getPaginate } from "../src/middlwares/getPaginate";
import { getWhere } from "../src/middlwares/getWhere";
import { mockNext, mockReq, mockRes } from "./_helpers";
import { SimpleModel } from "./_models";

/**
 * Projeto que guarda o estado do request no AsyncLocalStorage (e não no `res`)
 * precisava forkar os três middlewares só para trocar o destino da escrita.
 */
describe("middlewares espelham no contexto do request", () => {
  afterEach(() => setHandlerContext(() => undefined));

  function withContexto() {
    const ctx: Record<string, any> = { entity: 1 };
    setHandlerContext(() => ctx);
    return ctx;
  }

  test("getWhere escreve no res.locals E no contexto", () => {
    const ctx = withContexto();
    const res = mockRes();
    getWhere(mockReq({ query: { name: "Ana" } }), res, mockNext(), SimpleModel);

    expect(res.locals.where).toBeDefined();
    expect(ctx.where).toBe(res.locals.where);
  });

  test("getOrderBy escreve nos dois", () => {
    const ctx = withContexto();
    const res = mockRes();
    getOrderBy(
      mockReq({ query: { orderBy: "name", orderMethod: "asc" } }),
      res,
      mockNext(),
      SimpleModel,
    );

    expect(res.locals.orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
    expect(ctx.orderBy).toBe(res.locals.orderBy);
  });

  test("getPaginate escreve nos dois", () => {
    const ctx = withContexto();
    const res = mockRes();
    getPaginate(
      mockReq({ headers: { paginate: "true", page: "2", offset: "20" } }),
      res,
      mockNext(),
    );

    expect(res.locals.paginate).toEqual({ skip: 20, take: 20, page: 2 });
    expect(ctx.paginate).toBe(res.locals.paginate);
  });

  test("getColumns escreve nos dois", () => {
    const ctx = withContexto();
    const res = mockRes();
    getColumns(mockReq({ query: { fields: "name" } }), res, mockNext(), SimpleModel);

    expect(res.locals.columns).toEqual({ id: true, name: true });
    expect(ctx.columns).toBe(res.locals.columns);
  });

  test("getPaginate sem o header não toca em nada", () => {
    const ctx = withContexto();
    const res = mockRes();
    getPaginate(mockReq(), res, mockNext());

    expect(res.locals.paginate).toBeUndefined();
    expect("paginate" in ctx).toBe(false);
  });

  test("SEM contexto configurado, nada muda — só o res.locals", () => {
    setHandlerContext(() => undefined);
    const res = mockRes();
    const next = mockNext();

    expect(() => {
      getWhere(mockReq({ query: { name: "Ana" } }), res, next, SimpleModel);
      getPaginate(mockReq({ headers: { paginate: "true" } }), res, next);
    }).not.toThrow();
    expect(res.locals.where).toBeDefined();
    expect(res.locals.paginate).toBeDefined();
  });
});

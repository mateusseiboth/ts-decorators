import { describe, expect, test } from "bun:test";

import { clearAllCache } from "../src/decorators/cacheable";
import { convertBigIntValues } from "../src/functions/sql";
import { getWhere } from "../src/middlwares/getWhere";
import { mockNext, mockReq, mockRes } from "./_helpers";
import { RuaModel, SimpleModel } from "./_models";

describe("hot paths", () => {
  describe("getWhere percorre a QUERY, não o model inteiro", () => {
    test("query vazia não gera condição alguma", () => {
      const res = mockRes();
      getWhere(mockReq({ query: {} }), res, mockNext(), SimpleModel);
      expect(res.locals.where).toEqual({});
    });

    test("chave fora do model é ignorada", () => {
      const res = mockRes();
      getWhere(mockReq({ query: { naoExiste: "x" } }), res, mockNext(), SimpleModel);
      expect(res.locals.where).toEqual({});
    });

    test("só o campo pedido entra no where", () => {
      const res = mockRes();
      getWhere(mockReq({ query: { name: "Ana", naoExiste: "x" } }), res, mockNext(), SimpleModel);
      expect(JSON.stringify(res.locals.where)).toContain("Ana");
      expect(JSON.stringify(res.locals.where)).not.toContain("naoExiste");
    });

    test("campo aninhado continua sendo aceito pela notação com ponto", () => {
      const res = mockRes();
      getWhere(mockReq({ query: { "bairro.name": "Centro" } }), res, mockNext(), RuaModel);
      expect(JSON.stringify(res.locals.where)).toContain("Centro");
    });

    test("query com chave herdada de Object.prototype não vira filtro", () => {
      const res = mockRes();
      const query = Object.create({ toString: "hack" });
      query.name = "Ana";
      getWhere(mockReq({ query }), res, mockNext(), SimpleModel);
      expect(JSON.stringify(res.locals.where)).not.toContain("hack");
    });
  });

  describe("convertBigIntValues", () => {
    test("converte bigint para string em profundidade", () => {
      const input = { a: BigInt(1), b: { c: BigInt(2), d: "x" }, e: [BigInt(3)] };
      expect(convertBigIntValues(input)).toEqual({
        a: "1",
        b: { c: "2", d: "x" },
        e: ["3"],
      } as any);
    });

    test("Date vira ISO string", () => {
      const date = new Date("2026-01-02T03:04:05.000Z");
      expect(convertBigIntValues({ at: date } as any)).toEqual({
        at: "2026-01-02T03:04:05.000Z",
      } as any);
    });

    test("null e primitivos passam intactos", () => {
      expect(convertBigIntValues(null as any)).toBe(null as any);
      expect(convertBigIntValues(7 as any)).toBe(7 as any);
      expect(convertBigIntValues({ a: null, b: undefined } as any)).toEqual({
        a: null,
        b: undefined,
      } as any);
    });

    test("não muta o objeto de entrada", () => {
      const input: any = { a: BigInt(1) };
      convertBigIntValues(input);
      expect(typeof input.a).toBe("bigint");
    });

    test("array de objetos preserva a ordem", () => {
      const out: any = convertBigIntValues([{ id: BigInt(2) }, { id: BigInt(1) }] as any);
      expect(out.map((o: any) => o.id)).toEqual(["2", "1"]);
    });
  });

  describe("clearAllCache", () => {
    test("continua limpando o cache sem erro", () => {
      expect(() => clearAllCache()).not.toThrow();
    });
  });
});

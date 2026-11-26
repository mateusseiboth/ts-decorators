import { describe, expect, test } from "bun:test";

import { getOrderBy } from "../src/middlwares/getOrderBy";
import { getPaginate } from "../src/middlwares/getPaginate";
import {
  buildWhereFromQuery,
  createWhereCondition,
  createWhereConditionQuery,
  getWhere,
} from "../src/middlwares/getWhere";
import { mockNext, mockReq, mockRes } from "./_helpers";
import { CityFieldModel, SimpleModel, UserModel } from "./_models";

describe("Middlewares", () => {
  describe("getPaginate", () => {
    test("seta paginate quando header paginate=true", () => {
      const req = mockReq({ headers: { paginate: "true", page: "2", offset: "20" } });
      const res = mockRes();
      const next = mockNext();
      getPaginate(req, res, next);
      expect(next.called).toBe(true);
      expect(res.locals.paginate).toEqual({ skip: 20, take: 20, page: 2 });
    });

    test("page=1, offset=10 como default", () => {
      const req = mockReq({ headers: { paginate: "true" } });
      const res = mockRes();
      const next = mockNext();
      getPaginate(req, res, next);
      expect(res.locals.paginate).toEqual({ skip: 0, take: 10, page: 1 });
    });

    const invalidos: Array<[Record<string, string>, string[]]> = [
      [{ page: "0" }, ["page"]],
      [{ page: "-1" }, ["page"]],
      [{ page: "abc" }, ["page"]],
      [{ offset: "0" }, ["offset"]],
      [{ offset: "-3" }, ["offset"]],
      [{ offset: "abc" }, ["offset"]],
      [{ page: "0", offset: "0" }, ["page", "offset"]],
    ];
    for (const [cabecalhos, caminhos] of invalidos) {
      test(`responde 400 com ${JSON.stringify(cabecalhos)}`, () => {
        const req = mockReq({ headers: { paginate: "true", ...cabecalhos } });
        const res = mockRes();
        const next = mockNext();
        getPaginate(req, res, next);
        expect(next.called).toBe(false);
        expect(res.statusCode).toBe(400);
        expect(res._body.message).toBe("Paginação inválida.");
        expect(res._body.errors.map((e: { path: string }) => e.path)).toEqual(caminhos);
        expect(res.locals.paginate).toBeUndefined();
      });
    }

    test("o que o parseInt já aceitava continua valendo (ex.: '2abc' é 2)", () => {
      const req = mockReq({ headers: { paginate: "true", page: "2abc", offset: "20" } });
      const res = mockRes();
      const next = mockNext();
      getPaginate(req, res, next);
      expect(next.called).toBe(true);
      expect(res.locals.paginate).toEqual({ skip: 20, take: 20, page: 2 });
    });

    test("não seta paginate quando header ausente", () => {
      const res = mockRes();
      const next = mockNext();
      getPaginate(mockReq(), res, next);
      expect(res.locals.paginate).toBeUndefined();
      expect(next.called).toBe(true);
    });
  });

  describe("getOrderBy", () => {
    test("seta orderBy quando query válida", () => {
      const req = mockReq({ query: { orderBy: "name", orderMethod: "asc" } });
      const res = mockRes();
      const next = mockNext();
      getOrderBy(req, res, next, SimpleModel);
      expect(next.called).toBe(true);
      expect(res.locals.orderBy).toEqual([{ name: "asc" }]);
    });

    test("chama next sem setar se orderBy não está na query", () => {
      const res = mockRes();
      const next = mockNext();
      getOrderBy(mockReq(), res, next, SimpleModel);
      expect(next.called).toBe(true);
      expect(res.locals.orderBy).toBeUndefined();
    });

    test("ignora campo que não existe no model", () => {
      const req = mockReq({ query: { orderBy: "nonexistent", orderMethod: "desc" } });
      const res = mockRes();
      const next = mockNext();
      getOrderBy(req, res, next, SimpleModel);
      expect(res.locals.orderBy).toEqual([]);
    });

    test("campo de relação to-one vira o objeto aninhado do Prisma 7", () => {
      const req = mockReq({ query: { orderBy: "state.country.name", orderMethod: "desc" } });
      const res = mockRes();
      getOrderBy(req, res, mockNext(), CityFieldModel);
      expect(res.locals.orderBy).toEqual([{ state: { country: { name: "desc" } } }]);
    });

    test("campo de relação to-many é ignorado: não há UMA linha para ordenar", () => {
      const req = mockReq({ query: { orderBy: "posts.title", orderMethod: "asc" } });
      const res = mockRes();
      getOrderBy(req, res, mockNext(), UserModel);
      expect(res.locals.orderBy).toEqual([]);
    });
  });

  describe("getWhere", () => {
    test("cria where com campo string usando equals", () => {
      const req = mockReq({ query: { name: "Test" } });
      const res = mockRes();
      const next = mockNext();
      getWhere(req, res, next, SimpleModel);
      expect(next.called).toBe(true);
      expect(res.locals.where).toBeDefined();
    });

    test("cria where com campo numérico", () => {
      const req = mockReq({ query: { age: "25" } });
      const res = mockRes();
      const next = mockNext();
      getWhere(req, res, next, SimpleModel);
      expect(res.locals.where).toBeDefined();
    });

    test("suporta customFields", () => {
      const req = mockReq({ query: {} });
      const res = mockRes();
      const next = mockNext();
      getWhere(req, res, next, SimpleModel, { active: true });
      expect(res.locals.where).toBeDefined();
      expect(res.locals.where.AND).toBeDefined();
    });
  });

  describe("createWhereConditionQuery", () => {
    test("equals em campo string", () => {
      const result = createWhereConditionQuery("Test", "name", { name: "string" });
      expect(result.OR.length).toBeGreaterThanOrEqual(1);
      expect(result.OR[0]).toHaveProperty("name");
    });

    test("contains em campo string", () => {
      const result = createWhereConditionQuery("contains:abc", "name", { name: "string" });
      expect(result.OR[0].name).toHaveProperty("contains");
      expect(result.OR[0].name.mode).toBe("insensitive");
    });

    test("negação com !", () => {
      const result = createWhereConditionQuery("!excluded", "name", { name: "string" });
      expect(result.NOT.length).toBeGreaterThanOrEqual(1);
    });

    test("campo numérico converte para Number", () => {
      const result = createWhereConditionQuery("42", "age", { age: "number" });
      expect(result.OR[0].age.equals).toBe(42);
    });

    test("campo boolean converte via Controller.safe.Boolean", () => {
      const result = createWhereConditionQuery("true", "isAdmin", { isAdmin: "boolean" });
      expect(result.OR[0].isAdmin).toEqual({ equals: true });
    });

    test("múltiplos valores com ;", () => {
      const result = createWhereConditionQuery("a;b;c", "name", { name: "string" });
      expect(result.OR.length).toBe(3);
    });

    test("greaterThan em campo numérico", () => {
      const result = createWhereConditionQuery("greaterThan:10", "age", { age: "number" });
      expect(result.OR[0].age).toHaveProperty("gt");
    });

    test("lessThan em campo numérico", () => {
      const result = createWhereConditionQuery("lessThan:5", "score", { score: "number" });
      expect(result.OR[0].score).toHaveProperty("lt");
    });

    test("in em campo string", () => {
      const result = createWhereConditionQuery("in:a,b,c", "name", { name: "string" });
      expect(result.OR[0].name).toHaveProperty("in");
    });

    test("campo date gera lte/gte", () => {
      const result = createWhereConditionQuery("2024-01-15", "birthDate", { birthDate: "date" });
      expect(result.OR[0].birthDate).toHaveProperty("lte");
      expect(result.OR[0].birthDate).toHaveProperty("gte");
    });

    test("campos Temporal de data também geram lte/gte", () => {
      const zoned = createWhereConditionQuery("2024-01-15", "inicio", { inicio: "zoneddatetime" });
      expect(zoned.OR[0].inicio).toHaveProperty("lte");
      expect(zoned.OR[0].inicio).toHaveProperty("gte");

      const plain = createWhereConditionQuery("2024-01-15", "competencia", {
        competencia: "plaindate",
      });
      expect(plain.OR[0].competencia).toHaveProperty("gte");
    });

    test("duration não é tratado como data", () => {
      const result = createWhereConditionQuery("PT1H", "duracao", { duracao: "duration" });
      expect(result.OR[0].duracao).toEqual({ equals: "PT1H" });
    });

    test("range numérico com -", () => {
      const result = createWhereConditionQuery("1-5", "age", { age: "number" });
      // Uma condição só: expandir valor a valor deixava `1-100000000` derrubar o processo.
      expect(result.OR).toEqual([{ age: { gte: 1, lte: 5 } }]);
    });
  });

  describe("createWhereCondition", () => {
    test("equals simples", () => {
      const result = createWhereCondition("hello", "name", { name: "string" });
      expect(result.OR.length).toBeGreaterThanOrEqual(1);
    });

    test("contains em string", () => {
      const result = createWhereCondition("contains:abc", "name", { name: "string" });
      expect(result.OR[0].name).toHaveProperty("contains");
    });

    test("negação", () => {
      const result = createWhereCondition("!val", "name", { name: "string" });
      expect(result.NOT.length).toBeGreaterThanOrEqual(1);
    });

    test("retorna objeto direto se value é objeto", () => {
      const obj = { equals: 5 };
      const result = createWhereCondition(obj, "age", { age: "number" });
      expect(result).toEqual(obj);
    });

    test("notNull vira not null, sem olhar o valor nem o tipo do campo", () => {
      const esperado = { OR: [{ data_baixa: { not: null } }], NOT: [] };
      expect(createWhereCondition("notNull:null", "data_baixa", { data_baixa: "Date" })).toEqual(
        esperado,
      );
      expect(createWhereCondition("notNull:", "data_baixa", { data_baixa: "Date" })).toEqual(
        esperado,
      );
      expect(createWhereCondition("notNull:true", "data_baixa", { data_baixa: "string" })).toEqual(
        esperado,
      );
    });

    test("isNull vira null, sem olhar o valor nem o tipo do campo", () => {
      const esperado = { OR: [{ data_baixa: null }], NOT: [] };
      expect(createWhereCondition("isNull:null", "data_baixa", { data_baixa: "Date" })).toEqual(
        esperado,
      );
      expect(createWhereCondition("isNull:", "data_baixa", { data_baixa: "Date" })).toEqual(
        esperado,
      );
      expect(
        createWhereCondition("isNull:2026-01-15", "data_baixa", { data_baixa: "Date" }),
      ).toEqual(esperado);
    });
  });

  describe("buildWhereFromQuery", () => {
    test("constrói where a partir de query params", () => {
      const query = { name: "Test", age: "30" };
      const where = buildWhereFromQuery(query, SimpleModel);
      expect(where).toBeDefined();
    });

    test("suporta customFields", () => {
      const where = buildWhereFromQuery({}, SimpleModel, { active: true });
      expect(where.AND).toBeDefined();
    });

    test("notNull e isNull filtram pela nulidade do campo", () => {
      expect(buildWhereFromQuery({ name: "notNull:null" }, SimpleModel)).toEqual({
        name: { not: null },
      });
      expect(buildWhereFromQuery({ name: "isNull:null" }, SimpleModel)).toEqual({ name: null });
    });

    test("query vazia retorna where vazio", () => {
      const where = buildWhereFromQuery({}, SimpleModel);
      expect(Object.keys(where).length).toBe(0);
    });
  });
});

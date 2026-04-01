import {describe, expect, test} from "bun:test";
import {getOrderBy} from "../src/middlwares/getOrderBy";
import {getPaginate} from "../src/middlwares/getPaginate";
import {buildWhereFromQuery, createWhereCondition, createWhereConditionQuery, getWhere} from "../src/middlwares/getWhere";
import {mockNext, mockReq, mockRes} from "./_helpers";
import {SimpleModel} from "./_models";

describe("Middlewares", () => {
  describe("getPaginate", () => {
    test("seta paginate quando header paginate=true", () => {
      const req = mockReq({headers: {paginate: "true", page: "2", offset: "20"}});
      const res = mockRes();
      const next = mockNext();
      getPaginate(req, res, next);
      expect(next.called).toBe(true);
      expect(res.locals.paginate).toEqual({skip: 20, take: 20, page: 2});
    });

    test("page=1, offset=10 como default", () => {
      const req = mockReq({headers: {paginate: "true"}});
      const res = mockRes();
      const next = mockNext();
      getPaginate(req, res, next);
      expect(res.locals.paginate).toEqual({skip: 0, take: 10, page: 1});
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
      const req = mockReq({query: {orderBy: "name", orderMethod: "asc"}});
      const res = mockRes();
      const next = mockNext();
      getOrderBy(req, res, next, SimpleModel);
      expect(next.called).toBe(true);
      expect(res.locals.orderBy).toEqual([{name: "asc"}]);
    });

    test("chama next sem setar se orderBy não está na query", () => {
      const res = mockRes();
      const next = mockNext();
      getOrderBy(mockReq(), res, next, SimpleModel);
      expect(next.called).toBe(true);
      expect(res.locals.orderBy).toBeUndefined();
    });

    test("ignora campo que não existe no model", () => {
      const req = mockReq({query: {orderBy: "nonexistent", orderMethod: "desc"}});
      const res = mockRes();
      const next = mockNext();
      getOrderBy(req, res, next, SimpleModel);
      expect(res.locals.orderBy).toEqual([]);
    });
  });

  describe("getWhere", () => {
    test("cria where com campo string usando equals", () => {
      const req = mockReq({query: {name: "Test"}});
      const res = mockRes();
      const next = mockNext();
      getWhere(req, res, next, SimpleModel);
      expect(next.called).toBe(true);
      expect(res.locals.where).toBeDefined();
    });

    test("cria where com campo numérico", () => {
      const req = mockReq({query: {age: "25"}});
      const res = mockRes();
      const next = mockNext();
      getWhere(req, res, next, SimpleModel);
      expect(res.locals.where).toBeDefined();
    });

    test("suporta customFields", () => {
      const req = mockReq({query: {}});
      const res = mockRes();
      const next = mockNext();
      getWhere(req, res, next, SimpleModel, {active: true});
      expect(res.locals.where).toBeDefined();
      expect(res.locals.where.AND).toBeDefined();
    });
  });

  describe("createWhereConditionQuery", () => {
    test("equals em campo string", () => {
      const result = createWhereConditionQuery("Test", "name", {name: "string"});
      expect(result.OR.length).toBeGreaterThanOrEqual(1);
      expect(result.OR[0]).toHaveProperty("name");
    });

    test("contains em campo string", () => {
      const result = createWhereConditionQuery("contains:abc", "name", {name: "string"});
      expect(result.OR[0].name).toHaveProperty("contains");
      expect(result.OR[0].name.mode).toBe("insensitive");
    });

    test("negação com !", () => {
      const result = createWhereConditionQuery("!excluded", "name", {name: "string"});
      expect(result.NOT.length).toBeGreaterThanOrEqual(1);
    });

    test("campo numérico converte para Number", () => {
      const result = createWhereConditionQuery("42", "age", {age: "number"});
      expect(result.OR[0].age.equals).toBe(42);
    });

    test("campo boolean converte via Controller.safe.Boolean", () => {
      const result = createWhereConditionQuery("true", "isAdmin", {isAdmin: "boolean"});
      expect(result.OR[0].isAdmin).toEqual({equals: true});
    });

    test("múltiplos valores com ;", () => {
      const result = createWhereConditionQuery("a;b;c", "name", {name: "string"});
      expect(result.OR.length).toBe(3);
    });

    test("greaterThan em campo numérico", () => {
      const result = createWhereConditionQuery("greaterThan:10", "age", {age: "number"});
      expect(result.OR[0].age).toHaveProperty("gt");
    });

    test("lessThan em campo numérico", () => {
      const result = createWhereConditionQuery("lessThan:5", "score", {score: "number"});
      expect(result.OR[0].score).toHaveProperty("lt");
    });

    test("in em campo string", () => {
      const result = createWhereConditionQuery("in:a,b,c", "name", {name: "string"});
      expect(result.OR[0].name).toHaveProperty("in");
    });

    test("campo date gera lte/gte", () => {
      const result = createWhereConditionQuery("2024-01-15", "birthDate", {birthDate: "date"});
      expect(result.OR[0].birthDate).toHaveProperty("lte");
      expect(result.OR[0].birthDate).toHaveProperty("gte");
    });

    test("range numérico com -", () => {
      const result = createWhereConditionQuery("1-5", "age", {age: "number"});
      // expandRanges deve gerar 5 entradas (1,2,3,4,5)
      expect(result.OR.length).toBe(5);
    });
  });

  describe("createWhereCondition", () => {
    test("equals simples", () => {
      const result = createWhereCondition("hello", "name", {name: "string"});
      expect(result.OR.length).toBeGreaterThanOrEqual(1);
    });

    test("contains em string", () => {
      const result = createWhereCondition("contains:abc", "name", {name: "string"});
      expect(result.OR[0].name).toHaveProperty("contains");
    });

    test("negação", () => {
      const result = createWhereCondition("!val", "name", {name: "string"});
      expect(result.NOT.length).toBeGreaterThanOrEqual(1);
    });

    test("retorna objeto direto se value é objeto", () => {
      const obj = {equals: 5};
      const result = createWhereCondition(obj, "age", {age: "number"});
      expect(result).toEqual(obj);
    });
  });

  describe("buildWhereFromQuery", () => {
    test("constrói where a partir de query params", () => {
      const query = {name: "Test", age: "30"};
      const where = buildWhereFromQuery(query, SimpleModel);
      expect(where).toBeDefined();
    });

    test("suporta customFields", () => {
      const where = buildWhereFromQuery({}, SimpleModel, {active: true});
      expect(where.AND).toBeDefined();
    });

    test("query vazia retorna where vazio", () => {
      const where = buildWhereFromQuery({}, SimpleModel);
      expect(Object.keys(where).length).toBe(0);
    });
  });
});

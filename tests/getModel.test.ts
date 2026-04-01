import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {clearLegacyWarnings} from "../src/decorators/_proxy";
import {DAOFor, getAllDAOs, getAllModels, getDAO, getModel, ModelTagged} from "../src/decorators/getModel";
import {captureLogs, captureWarnings, fakeClassContext} from "./_helpers";
import {BairroModel, RuaModel, SimpleModel} from "./_models";

describe("getModel / ModelTagged / DAOFor", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  let logCap: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    clearLegacyWarnings();
    warnCap = captureWarnings();
    logCap = captureLogs();
  });
  afterEach(() => {
    warnCap.restore();
    logCap.restore();
  });

  describe("ModelTagged (legacy — registrado via _models.ts)", () => {
    test("RuaModel registrado com tag 7771", () => {
      expect(getModel(7771)).toBe(RuaModel);
    });
    test("BairroModel registrado com tag 7770", () => {
      expect(getModel(7770)).toBe(BairroModel);
    });
    test("SimpleModel registrado com tag 7772", () => {
      expect(getModel(7772)).toBe(SimpleModel);
    });
    test("retorna undefined para tag não registrada", () => {
      expect(getModel(99999)).toBeUndefined();
    });
  });

  describe("ModelTagged (TC39 — simulado)", () => {
    test("registra SEM warning com context", () => {
      class TC39Model {
        static tag = 8880;
      }
      const ctx = fakeClassContext("TC39Model");
      ModelTagged(TC39Model, ctx);
      expect(getModel(8880)).toBe(TC39Model);
      expect(warnCap.warnings.filter((w) => w.includes("ModelTagged")).length).toBe(0);
    });
  });

  describe("DAOFor (legacy)", () => {
    test("registra DAO e vincula model", () => {
      class TestDAO {}
      DAOFor(7772)(TestDAO);
      expect(getDAO(7772)).toBe(TestDAO);
      expect((TestDAO as any).model).toBe(SimpleModel);
      expect(warnCap.warnings.some((w) => w.includes("DAOFor"))).toBe(true);
    });
  });

  describe("DAOFor (TC39)", () => {
    test("registra SEM warning com context", () => {
      class TC39DAO {}
      DAOFor(7771)(TC39DAO, fakeClassContext("TC39DAO"));
      expect(getDAO(7771)).toBe(TC39DAO);
      expect(warnCap.warnings.filter((w) => w.includes("DAOFor")).length).toBe(0);
    });
  });

  describe("getAllModels / getAllDAOs", () => {
    test("retornam arrays não-vazios", () => {
      expect(getAllModels().length).toBeGreaterThan(0);
      expect(getAllDAOs().length).toBeGreaterThan(0);
    });
    test("getAllModels contém RuaModel", () => {
      expect(getAllModels()).toContain(RuaModel);
    });
  });
});

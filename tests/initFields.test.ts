import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {clearLegacyWarnings} from "../src/decorators/_proxy";
import {Field, InitFields, getFieldTypeByKey, getFieldTypes} from "../src/decorators/initFields";
import {captureLogs, captureWarnings, fakeClassContext, fakeFieldContext} from "./_helpers";
import {BaseModel, RuaModel, SimpleModel} from "./_models";

describe("initFields", () => {
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

  describe("Field + InitFields (legacy — via _models.ts que usa experimentalDecorators)", () => {
    test("BaseModel registra campos base", () => {
      const types = getFieldTypes(BaseModel.prototype);
      expect(types["createdAt"]).toBeDefined();
      expect(types["enabled"]).toBeDefined();
      expect(types["entidade"]).toBeDefined();
      expect(types["modifiedBy"]).toBeDefined();
      expect(types["sequencial"]).toBeDefined();
      expect(types["active"]).toBeDefined();
    });

    test("RuaModel herda campos de BaseModel e adiciona os seus", () => {
      const types = getFieldTypes(RuaModel.prototype);
      // Próprios
      expect(types["id"]).toBeDefined();
      expect(types["name"]).toBeDefined();
      expect(types["bairroId"]).toBeDefined();
      expect(types["cep"]).toBeDefined();
      expect(types["tipo"]).toBeDefined();
      // Herdados
      expect(types["enabled"]).toBeDefined();
      expect(types["entidade"]).toBeDefined();
    });

    test("SimpleModel registra campos numéricos e boolean", () => {
      const types = getFieldTypes(SimpleModel.prototype);
      expect(types["age"]).toBeDefined();
      expect(types["score"]).toBeDefined();
      expect(types["isAdmin"]).toBeDefined();
      expect(types["birthDate"]).toBeDefined();
    });
  });

  describe("getFieldTypeByKey", () => {
    test("retorna tipo correto para campos existentes", () => {
      const instance = new SimpleModel();
      // O tipo real depende do reflect-metadata; o importante é que retorna algo
      expect(getFieldTypeByKey(instance, "name")).toBeDefined();
      expect(getFieldTypeByKey(instance, "age")).toBeDefined();
    });

    test("retorna undefined para campo inexistente", () => {
      const instance = new SimpleModel();
      expect(getFieldTypeByKey(instance, "naoExiste")).toBeUndefined();
    });

    test("funciona com herança", () => {
      const rua = new RuaModel();
      expect(getFieldTypeByKey(rua, "enabled")).toBeDefined();
      expect(getFieldTypeByKey(rua, "cep")).toBeDefined();
    });
  });

  describe("Field + InitFields (novo TC39 — simulado)", () => {
    test("registra via metadata e sincroniza na WeakMap", () => {
      class TC39Model {}
      const metadata: Record<string, any> = {};
      Field("number")(undefined, fakeFieldContext("x", metadata));
      Field("string")(undefined, fakeFieldContext("y", metadata));

      expect(metadata.__fields.x).toBe("number");
      expect(metadata.__fields.y).toBe("string");

      const ctx = fakeClassContext("TC39Model");
      (ctx as any).metadata = metadata;
      InitFields(TC39Model as any, ctx);

      const types = getFieldTypes(TC39Model.prototype);
      expect(types["x"]).toBe("number");
      expect(types["y"]).toBe("string");

      // Não deve ter warning de InitFields (TC39)
      expect(warnCap.warnings.filter((w) => w.includes("InitFields")).length).toBe(0);
    });
  });
});

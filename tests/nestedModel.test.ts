import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {clearLegacyWarnings} from "../src/decorators/_proxy";
import {NestedModel, getNestedModel} from "../src/decorators/nestedModel";
import {collectFieldTypes} from "../src/functions/collectFieldsTypes";
import {captureLogs, captureWarnings, fakeFieldContext} from "./_helpers";
import {BairroModel, RuaModel} from "./_models";

describe("NestedModel + collectFieldTypes", () => {
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

  describe("NestedModel (legacy — via _models.ts)", () => {
    test("getNestedModel retorna BairroModel para 'bairro' em RuaModel", () => {
      const nested = getNestedModel(RuaModel.prototype, "bairro");
      expect(nested).toBe(BairroModel);
    });

    test("getNestedModel retorna undefined para campo sem nested", () => {
      expect(getNestedModel(RuaModel.prototype, "cep")).toBeUndefined();
    });

    test("getNestedModel retorna undefined para campo inexistente", () => {
      expect(getNestedModel(RuaModel.prototype, "naoExiste")).toBeUndefined();
    });
  });

  describe("NestedModel (TC39 — simulado)", () => {
    test("registra no metadata e não emite warning", () => {
      class FakeNested {}
      const metadata: Record<string, any> = {};
      NestedModel(FakeNested)(undefined, fakeFieldContext("child", metadata));
      expect(metadata.__nested.child).toBe(FakeNested);
      expect(warnCap.warnings.filter((w) => w.includes("NestedModel")).length).toBe(0);
    });
  });

  describe("collectFieldTypes", () => {
    test("coleta campos flat de SimpleModel", () => {
      const {SimpleModel} = require("./_models");
      const fields = collectFieldTypes(new SimpleModel());
      expect(fields["id"]).toBeDefined();
      expect(fields["name"]).toBeDefined();
      expect(fields["age"]).toBeDefined();
    });

    test("coleta campos nested de RuaModel → BairroModel", () => {
      const fields = collectFieldTypes(new RuaModel());
      // Campos diretos
      expect(fields["id"]).toBeDefined();
      expect(fields["name"]).toBeDefined();
      expect(fields["cep"]).toBeDefined();
      // Campos nested prefixados com "bairro."
      expect(fields["bairro.id"]).toBeDefined();
      expect(fields["bairro.name"]).toBeDefined();
    });
  });
});

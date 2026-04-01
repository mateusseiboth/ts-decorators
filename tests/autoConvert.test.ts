import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {clearLegacyWarnings} from "../src/decorators/_proxy";
import {AutoConvert} from "../src/decorators/autoConvert";
import {captureLogs, captureWarnings, fakeMethodContext} from "./_helpers";
import {SimpleModel} from "./_models";

describe("AutoConvert", () => {
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

  describe("via setData no BaseModel (legacy)", () => {
    test("converte string para number", () => {
      const model = new SimpleModel();
      model.setData({age: "25", name: "Test"});
      expect(model.age).toBe(25);
    });

    test("converte string para boolean", () => {
      const model = new SimpleModel();
      model.setData({isAdmin: "true"});
      expect(model.isAdmin).toBe(true);
    });

    test("converte 'false' para false", () => {
      const model = new SimpleModel();
      model.setData({isAdmin: "false"});
      expect(model.isAdmin).toBe(false);
    });

    test("converte number NaN para null", () => {
      const model = new SimpleModel();
      model.setData({age: "abc"});
      expect(model.age).toBeNull();
    });

    test("converte null/undefined para null", () => {
      const model = new SimpleModel();
      model.setData({age: null, name: undefined});
      expect(model.age).toBeNull();
      expect(model.name).toBeNull();
    });

    test("converte string de data para Date", () => {
      const model = new SimpleModel();
      model.setData({birthDate: "2024-01-15"});
      expect(model.birthDate).toBeInstanceOf(Date);
    });

    test("mantém campos não no model intocados", () => {
      const model = new SimpleModel();
      model.setData({campoFake: "xyz"});
      expect((model as any).campoFake).toBeUndefined();
    });
  });

  describe("AutoConvert TC39 (simulado)", () => {
    test("wraps método e converte tipos", () => {
      function process(this: any, data: any) {
        return data;
      }
      const wrapped = AutoConvert(process, fakeMethodContext("process"));
      expect(typeof wrapped).toBe("function");

      // Executa bound a um SimpleModel (para ter os field types)
      const instance = new SimpleModel();
      const result = wrapped.call(instance, {age: "42", name: 123});
      expect(result.age).toBe(42);
      expect(result.name).toBe("123");
    });

    test("retorna data original se falsy", () => {
      function fn(this: any, data: any) {
        return data;
      }
      const wrapped = AutoConvert(fn, fakeMethodContext("fn"));
      expect(wrapped.call({}, null)).toBeNull();
      expect(wrapped.call({}, undefined)).toBeUndefined();
    });

    test("não emite warning legacy", () => {
      function fn(this: any, d: any) {
        return d;
      }
      AutoConvert(fn, fakeMethodContext("fn"));
      expect(warnCap.warnings.filter((w) => w.includes("AutoConvert")).length).toBe(0);
    });
  });

  describe("AutoConvert Legacy (simulado direto)", () => {
    test("emite warning legacy", () => {
      class Svc {
        doStuff(data: any) {
          return data;
        }
      }
      const desc = Object.getOwnPropertyDescriptor(Svc.prototype, "doStuff")!;
      AutoConvert(Svc.prototype, "doStuff", desc);
      expect(warnCap.warnings.some((w) => w.includes("AutoConvert"))).toBe(true);
    });
  });
});

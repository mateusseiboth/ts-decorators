import {describe, expect, test} from "bun:test";
import {OPTIONS_FILTER} from "../src/constants/default";
import {Controller} from "../src/Controller";
import {ClientError} from "../src/errors/commons";

describe("Misc exports", () => {
  describe("OPTIONS_FILTER", () => {
    test("é array com filtros conhecidos", () => {
      expect(Array.isArray(OPTIONS_FILTER)).toBe(true);
      expect(OPTIONS_FILTER).toContain("contains");
      expect(OPTIONS_FILTER).toContain("equals");
      expect(OPTIONS_FILTER).toContain("startsWith");
      expect(OPTIONS_FILTER).toContain("endsWith");
      expect(OPTIONS_FILTER).toContain("greaterThan");
      expect(OPTIONS_FILTER).toContain("lessThan");
      expect(OPTIONS_FILTER).toContain("in");
      expect(OPTIONS_FILTER).toContain("inRange");
      expect(OPTIONS_FILTER).toContain("isNull");
    });
  });

  describe("ClientError", () => {
    test("é instância de Error", () => {
      const err = new ClientError("ops");
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("ops");
      expect(err.name).toBe("@mateusseiboth/client-error");
    });

    test("stack trace é capturada", () => {
      const err = new ClientError("test");
      expect(err.stack).toBeDefined();
    });
  });

  describe("Controller.safe.Boolean", () => {
    test("boolean true/false", () => {
      expect(Controller.safe.Boolean(true)).toBe(true);
      expect(Controller.safe.Boolean(false)).toBe(false);
    });

    test("string 'true'/'false'", () => {
      expect(Controller.safe.Boolean("true")).toBe(true);
      expect(Controller.safe.Boolean("false")).toBe(false);
      expect(Controller.safe.Boolean("TRUE")).toBe(true);
      expect(Controller.safe.Boolean("False")).toBe(false);
    });

    test("number 1/0", () => {
      expect(Controller.safe.Boolean(1)).toBe(true);
      expect(Controller.safe.Boolean(0)).toBe(false);
    });

    test("retorna undefined para valores inesperados", () => {
      expect(Controller.safe.Boolean("abc")).toBeUndefined();
      expect(Controller.safe.Boolean(42)).toBeUndefined();
    });
  });
});

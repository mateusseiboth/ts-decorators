import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearLegacyWarnings,
  isDecoratorContext,
  setLegacyWarnings,
  warnLegacy,
} from "../src/decorators/_proxy";
import { captureWarnings, fakeClassContext, fakeFieldContext, fakeMethodContext } from "./_helpers";

describe("_proxy", () => {
  let capture: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    clearLegacyWarnings();
    capture = captureWarnings();
  });

  afterEach(() => {
    capture.restore();
  });

  describe("isDecoratorContext", () => {
    test("true para class context", () => {
      expect(isDecoratorContext(fakeClassContext("X"))).toBe(true);
    });
    test("true para method context", () => {
      expect(isDecoratorContext(fakeMethodContext("m"))).toBe(true);
    });
    test("true para field context", () => {
      expect(isDecoratorContext(fakeFieldContext("f"))).toBe(true);
    });
    test("true para getter/setter/accessor", () => {
      expect(isDecoratorContext({ kind: "getter", name: "x" })).toBe(true);
      expect(isDecoratorContext({ kind: "setter", name: "x" })).toBe(true);
      expect(isDecoratorContext({ kind: "accessor", name: "x" })).toBe(true);
    });
    test("false para null/undefined/primitivo", () => {
      expect(isDecoratorContext(null)).toBe(false);
      expect(isDecoratorContext(undefined)).toBe(false);
      expect(isDecoratorContext(42)).toBe(false);
    });
    test("false para objeto sem kind ou kind inválido", () => {
      expect(isDecoratorContext({ name: "x" })).toBe(false);
      expect(isDecoratorContext({ kind: "banana" })).toBe(false);
      expect(isDecoratorContext({ kind: 123 })).toBe(false);
    });
  });

  describe("warnLegacy (deprecated)", () => {
    test("não avisa: o modo legado é o modo do pacote", () => {
      warnLegacy("Foo");
      warnLegacy("Bar");
      clearLegacyWarnings();
      setLegacyWarnings(true);
      warnLegacy("Foo");
      expect(capture.warnings).toEqual([]);
    });
  });
});

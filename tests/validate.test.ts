import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import "reflect-metadata";
import {clearLegacyWarnings} from "../src/decorators/_proxy";
import {WithValidation} from "../src/decorators/validate";
import {captureWarnings, fakeClassContext} from "./_helpers";

describe("Validate / WithValidation", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    clearLegacyWarnings();
    warnCap = captureWarnings();
  });
  afterEach(() => {
    warnCap.restore();
  });

  describe("WithValidation — Legacy", () => {
    test("emite warning sem context", () => {
      class C {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      WithValidation(C);
      expect(warnCap.warnings.some((w) => w.includes("WithValidation"))).toBe(true);
    });

    test("cria instância normalmente sem schemas", () => {
      class C {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
      }
      const D = WithValidation(C) as any;
      const i = new D(42);
      expect(i.x).toBe(42);
    });
  });

  describe("WithValidation — TC39", () => {
    test("SEM warning com context", () => {
      class C {
        constructor(public x: number) {}
      }
      WithValidation(C, fakeClassContext("C"));
      expect(warnCap.warnings.every((w) => !w.includes("WithValidation"))).toBe(true);
    });
  });
});

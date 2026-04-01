import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {clearLegacyWarnings} from "../src/decorators/_proxy";
import {logDecorator} from "../src/decorators/log";
import {captureWarnings, fakeClassContext} from "./_helpers";

describe("logDecorator", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    clearLegacyWarnings();
    warnCap = captureWarnings();
    (globalThis as any)._console = Function.prototype.bind.call(console.log, console);
  });
  afterEach(() => {
    warnCap.restore();
  });

  describe("Legacy", () => {
    test("aplica e emite warning", () => {
      class C {
        hello() {
          return "world";
        }
      }
      logDecorator(C as any);
      expect(warnCap.warnings.some((w) => w.includes("logDecorator"))).toBe(true);
    });

    test("mantém retorno do método", () => {
      class C {
        sum(a: number, b: number) {
          return a + b;
        }
      }
      const D = logDecorator(C as any);
      const i = new D();
      expect(i.sum(2, 3)).toBe(5);
    });
  });

  describe("TC39", () => {
    test("aplica SEM warning com context", () => {
      class C {
        hello() {
          return 1;
        }
      }
      logDecorator(C as any, fakeClassContext("C"));
      expect(warnCap.warnings.filter((w) => w.includes("logDecorator")).length).toBe(0);
    });
  });
});

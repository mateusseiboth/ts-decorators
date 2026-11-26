/**
 * Decorator de método aplicado a um método `async` devolve uma `async function`.
 *
 * O `@Transaction()` de classe dos apps só envolve o método cujo `constructor.name` é
 * `AsyncFunction`. Um substituto comum (`function`) tirava o método da transação em silêncio.
 */
import { describe, expect, test } from "bun:test";

import "reflect-metadata";

import { AdvisoryLock } from "../src/decorators/advisoryLock";
import { AfterCommit } from "../src/decorators/afterCommit";
import { AutoConvert } from "../src/decorators/autoConvert";
import { CacheMethod, Cached } from "../src/decorators/cacheable";
import { CircuitBreaker } from "../src/decorators/circuitBreaker";
import { Deprecated } from "../src/decorators/deprecated";
import { Emit } from "../src/decorators/emit";
import { MaskSensitive } from "../src/decorators/maskSensitive";
import { Mutex } from "../src/decorators/mutex";
import { RequiresRole } from "../src/decorators/requiresRole";
import { Retry } from "../src/decorators/retry";
import { Semaphore } from "../src/decorators/semaphore";
import { SingleFlight } from "../src/decorators/singleFlight";
import { Timed } from "../src/decorators/timed";
import { Timeout } from "../src/decorators/timeout";
import { RequiresPermission } from "../src/permissions/requiresPermission";
import { captureWarnings, fakeMethodContext } from "./_helpers";

type MethodDecorator = (...args: any[]) => any;

const DECORATORS: Record<string, () => MethodDecorator> = {
  AdvisoryLock: () => AdvisoryLock({ key: "trava" }),
  AfterCommit: () => AfterCommit("evento"),
  AutoConvert: () => AutoConvert,
  CacheMethod: () => CacheMethod(),
  Cached: () => Cached(),
  CircuitBreaker: () => CircuitBreaker(),
  Deprecated: () => Deprecated(),
  Emit: () => Emit("evento"),
  MaskSensitive: () => MaskSensitive(),
  Mutex: () => Mutex(),
  RequiresPermission: () => RequiresPermission("1:list"),
  RequiresRole: () => RequiresRole("admin"),
  Retry: () => Retry(),
  Semaphore: () => Semaphore(),
  SingleFlight: () => SingleFlight(),
  Timed: () => Timed(),
  Timeout: () => Timeout(1_000),
};

/** Os que envolvem o método sem precisar que ele seja assíncrono. */
const KEEP_SYNC = [
  "AdvisoryLock",
  "AutoConvert",
  "Cached",
  "CircuitBreaker",
  "Deprecated",
  "Retry",
  "SingleFlight",
  "Timed",
  "Timeout",
];

const isAsyncFunction = (fn: unknown) =>
  typeof fn === "function" && fn.constructor.name === "AsyncFunction";

async function carregar(this: unknown) {
  return 1;
}

const applyLegacy = (decorator: MethodDecorator, fn: Function) => {
  const descriptor: PropertyDescriptor = { value: fn, writable: true, configurable: true };
  const alvo = { constructor: class Alvo {} };
  return (decorator(alvo, fn.name, descriptor) ?? descriptor).value as Function;
};

const applyTc39 = (decorator: MethodDecorator, fn: Function) =>
  decorator(fn, fakeMethodContext(fn.name)) as Function;

describe("decorator de método em método async", () => {
  for (const [nome, build] of Object.entries(DECORATORS)) {
    test(`@${nome} (legacy) devolve AsyncFunction`, () => {
      const warnCap = captureWarnings();
      const decorado = applyLegacy(build(), carregar);
      warnCap.restore();
      expect(isAsyncFunction(decorado)).toBe(true);
    });

    test(`@${nome} (TC39) devolve AsyncFunction`, () => {
      const decorado = applyTc39(build(), carregar);
      expect(isAsyncFunction(decorado)).toBe(true);
    });
  }

  test("o substituto async guarda o nome do método", () => {
    const warnCap = captureWarnings();
    const decorado = applyLegacy(Retry(), carregar);
    warnCap.restore();
    expect(decorado.name).toBe("carregar");
  });

  for (const nome of KEEP_SYNC) {
    test(`@${nome} em método síncrono continua síncrono`, () => {
      const warnCap = captureWarnings();
      const decorado = applyLegacy(DECORATORS[nome](), function contar() {
        return 1;
      });
      warnCap.restore();
      expect(decorado.constructor.name).toBe("Function");
    });
  }
});

// ── Decorator de classe que só envolve AsyncFunction, como o @Transaction() dos apps ─────────

const isWrappableAsync = (candidate: unknown): candidate is Function =>
  typeof candidate === "function" && candidate.constructor.name === "AsyncFunction";

function TransactionLike(envolvidos: string[]) {
  return <T extends { prototype: object }>(constructor: T): T => {
    const prototype = constructor.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const original = prototype[name];
      if (name === "constructor" || !isWrappableAsync(original)) continue;
      envolvidos.push(name);
      Object.defineProperty(prototype, name, {
        value: async function (this: unknown, ...args: unknown[]) {
          return original.apply(this, args);
        },
        writable: true,
        configurable: true,
      });
    }
    return constructor;
  };
}

describe("decorator de classe que só envolve método async", () => {
  test("@AdvisoryLock e @Retry não tiram o método da transação", async () => {
    const envolvidos: string[] = [];
    const warnCap = captureWarnings();

    @TransactionLike(envolvidos)
    class ParcelaService {
      fator = 2;

      @AdvisoryLock({ key: "parcelas" })
      async quitar() {
        return "quitada";
      }

      @Retry({ attempts: 2, delayMs: 0 })
      async recalcular(valor: number) {
        return valor * this.fator;
      }
    }
    warnCap.restore();

    expect(envolvidos.sort()).toEqual(["quitar", "recalcular"]);
    expect(await new ParcelaService().recalcular(21)).toBe(42);
  });
});

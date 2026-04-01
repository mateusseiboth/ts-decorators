import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {clearLegacyWarnings} from "../src/decorators/_proxy";
import {Cacheable, CacheMethod, clearAllCache, getCacheStats} from "../src/decorators/cacheable";
import {captureLogs, captureWarnings, fakeClassContext, fakeMethodContext, mockReq, mockRes} from "./_helpers";

describe("Cacheable", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  let logCap: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    clearLegacyWarnings();
    clearAllCache();
    warnCap = captureWarnings();
    logCap = captureLogs();
  });
  afterEach(() => {
    warnCap.restore();
    logCap.restore();
  });

  describe("Cacheable (class) — Legacy", () => {
    test("emite warning", () => {
      class C {
        async get(req: any, res: any) {
          return res.json([1]);
        }
      }
      Cacheable()(C as any);
      expect(warnCap.warnings.some((w) => w.includes("Cacheable"))).toBe(true);
    });

    test("MISS na 1ª chamada, HIT na 2ª", async () => {
      class C {
        async get(req: any, res: any) {
          return res.json({items: [1]});
        }
      }
      const D = Cacheable({ttl: 5000})(C as any);
      const i = new D();
      const req = mockReq();

      const r1 = mockRes({locals: {entity: "1"}});
      await i.get(req, r1);
      expect(r1._headers["X-Cache"]).toBe("MISS");

      const r2 = mockRes({locals: {entity: "1"}});
      await i.get(req, r2);
      expect(r2._headers["X-Cache"]).toBe("HIT");
      expect(r2._body).toEqual({items: [1]});
    });

    test("write invalida cache", async () => {
      class C {
        async get(req: any, res: any) {
          return res.json({ok: 1});
        }
        async create(req: any, res: any) {
          return res.json({created: true});
        }
      }
      const D = Cacheable()(C as any);
      const i = new D();
      const req = mockReq();

      await i.get(req, mockRes({locals: {entity: "1"}}));
      await i.create(req, mockRes({locals: {entity: "1"}}));

      const r = mockRes({locals: {entity: "1"}});
      await i.get(req, r);
      expect(r._headers["X-Cache"]).toBe("MISS");
    });
  });

  describe("Cacheable (class) — TC39", () => {
    test("SEM warning com context", () => {
      class C {
        async get(req: any, res: any) {
          return res.json([]);
        }
      }
      Cacheable()(C as any, fakeClassContext("C"));
      expect(warnCap.warnings.every((w) => !w.includes("Cacheable"))).toBe(true);
    });
  });

  describe("CacheMethod — Legacy", () => {
    test("emite warning", () => {
      class S {
        async find(req: any, res: any) {
          return res.json([]);
        }
      }
      const d = Object.getOwnPropertyDescriptor(S.prototype, "find")!;
      CacheMethod({ttl: 5000})(S.prototype, "find", d);
      expect(warnCap.warnings.some((w) => w.includes("CacheMethod"))).toBe(true);
    });
  });

  describe("CacheMethod — TC39", () => {
    test("SEM warning e funciona cache HIT/MISS", async () => {
      let calls = 0;
      async function find(this: any, req: any, res: any) {
        calls++;
        return res.json({data: "x"});
      }
      const wrapped = CacheMethod({ttl: 5000})(find, fakeMethodContext("find"));
      expect(warnCap.warnings.every((w) => !w.includes("CacheMethod"))).toBe(true);

      const ctx = {constructor: {name: "SvcTC39"}};
      const req = mockReq();

      const r1 = mockRes({locals: {entity: "1"}});
      await wrapped.call(ctx, req, r1);
      expect(r1._headers["X-Cache"]).toBe("MISS");
      expect(calls).toBe(1);

      const r2 = mockRes({locals: {entity: "1"}});
      await wrapped.call(ctx, req, r2);
      expect(r2._headers["X-Cache"]).toBe("HIT");
      expect(calls).toBe(1);
    });
  });

  describe("clearAllCache / getCacheStats", () => {
    test("stats e limpeza funcionam", async () => {
      class S {
        async get(req: any, res: any) {
          return res.json(1);
        }
      }
      const D = Cacheable()(S as any, fakeClassContext("S"));
      await new D().get(mockReq(), mockRes({locals: {entity: "1"}}));
      expect(getCacheStats()["S"]).toBeGreaterThanOrEqual(1);
      clearAllCache();
      expect(getCacheStats()).toEqual({});
    });
  });
});

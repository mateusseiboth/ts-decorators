import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {clearLegacyWarnings} from "../src/decorators/_proxy";
import {RateLimit, RateLimitMethod, clearRateLimitStore, rateLimitMiddleware} from "../src/decorators/rateLimit";
import {captureWarnings, fakeClassContext, fakeMethodContext, mockNext, mockReq, mockRes} from "./_helpers";

describe("RateLimit", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    clearLegacyWarnings();
    clearRateLimitStore();
    warnCap = captureWarnings();
  });
  afterEach(() => {
    warnCap.restore();
  });

  describe("RateLimit (class) — Legacy", () => {
    test("emite warning", () => {
      class C {
        async get(req: any, res: any) {
          return res.json({ok: 1});
        }
      }
      RateLimit({maxRequests: 5})(C as any);
      expect(warnCap.warnings.some((w) => w.includes("RateLimit"))).toBe(true);
    });

    test("permite até maxRequests e bloqueia depois", async () => {
      class C {
        async get(req: any, res: any) {
          return res.json({ok: 1});
        }
      }
      const D = RateLimit({maxRequests: 2, windowMs: 60_000})(C as any);
      const i = new D();

      for (let n = 0; n < 2; n++) {
        const r = mockRes({locals: {entity: "1"}});
        await i.get(mockReq(), r);
        expect(r.statusCode).toBe(200);
      }

      const rBlocked = mockRes({locals: {entity: "1"}});
      await i.get(mockReq(), rBlocked);
      expect(rBlocked.statusCode).toBe(429);
      expect(rBlocked._body.code).toBe("RATE_LIMIT_EXCEEDED");
    });

    test("headers de rate limit são setados", async () => {
      class C {
        async get(req: any, res: any) {
          return res.json({});
        }
      }
      const D = RateLimit({maxRequests: 10})(C as any);
      const r = mockRes({locals: {entity: "1"}});
      await new D().get(mockReq(), r);
      expect(r._headers["X-RateLimit-Limit"]).toBe(10);
      expect(r._headers["X-RateLimit-Remaining"]).toBe(9);
    });
  });

  describe("RateLimit (class) — TC39", () => {
    test("SEM warning com context", () => {
      class C {
        async get(req: any, res: any) {
          return res.json({});
        }
      }
      RateLimit()(C as any, fakeClassContext("C"));
      expect(warnCap.warnings.every((w) => !w.includes("RateLimit"))).toBe(true);
    });
  });

  describe("RateLimitMethod — Legacy", () => {
    test("emite warning", () => {
      class S {
        async find(req: any, res: any) {
          return res.json([]);
        }
      }
      const d = Object.getOwnPropertyDescriptor(S.prototype, "find")!;
      RateLimitMethod({maxRequests: 3})(S.prototype, "find", d);
      expect(warnCap.warnings.some((w) => w.includes("RateLimitMethod"))).toBe(true);
    });

    test("bloqueia após maxRequests", async () => {
      class S {
        async find(req: any, res: any) {
          return res.json([1, 2]);
        }
      }
      const d = Object.getOwnPropertyDescriptor(S.prototype, "find")!;
      RateLimitMethod({maxRequests: 1, windowMs: 60_000})(S.prototype, "find", d);
      Object.defineProperty(S.prototype, "find", d);

      const i = new S();
      await i.find(mockReq(), mockRes({locals: {entity: "9"}}));

      const rBlocked = mockRes({locals: {entity: "9"}});
      await i.find(mockReq(), rBlocked);
      expect(rBlocked.statusCode).toBe(429);
    });
  });

  describe("RateLimitMethod — TC39", () => {
    test("SEM warning e bloqueia após maxRequests", async () => {
      async function search(this: any, req: any, res: any) {
        return res.json([]);
      }
      const wrapped = RateLimitMethod({maxRequests: 1, windowMs: 60_000})(search, fakeMethodContext("search"));
      expect(warnCap.warnings.every((w) => !w.includes("RateLimitMethod"))).toBe(true);

      const ctx = {constructor: {name: "SvcRL"}};
      await wrapped.call(ctx, mockReq(), mockRes({locals: {entity: "x"}}));

      const rB = mockRes({locals: {entity: "x"}});
      await wrapped.call(ctx, mockReq(), rB);
      expect(rB.statusCode).toBe(429);
    });
  });

  describe("rateLimitMiddleware", () => {
    test("funciona como middleware Express", async () => {
      const mw = rateLimitMiddleware({maxRequests: 2, windowMs: 60_000});

      for (let i = 0; i < 2; i++) {
        const n = mockNext();
        mw(mockReq({ip: "10.0.0.1"}), mockRes({locals: {entity: "1"}}), n);
        expect(n.called).toBe(true);
        expect(n.error).toBeUndefined();
      }

      const res3 = mockRes({locals: {entity: "1"}});
      const n3 = mockNext();
      mw(mockReq({ip: "10.0.0.1"}), res3, n3);
      expect(res3.statusCode).toBe(429);
      expect(n3.called).toBe(false);
    });
  });

  describe("clearRateLimitStore", () => {
    test("reseta contadores", async () => {
      class C {
        async get(req: any, res: any) {
          return res.json({});
        }
      }
      const D = RateLimit({maxRequests: 1})(C as any);
      const i = new D();
      await i.get(mockReq(), mockRes({locals: {entity: "1"}}));

      clearRateLimitStore();

      const r = mockRes({locals: {entity: "1"}});
      await i.get(mockReq(), r);
      expect(r.statusCode).toBe(200);
    });
  });
});

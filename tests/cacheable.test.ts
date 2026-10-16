import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearLegacyWarnings } from "../src/decorators/_proxy";
import {
  CacheProvider,
  Cacheable,
  CacheMethod,
  Cached,
  clearAllCache,
  getCacheStats,
  reportCacheKey,
} from "../src/decorators/cacheable";
import {
  captureLogs,
  captureWarnings,
  fakeClassContext,
  fakeMethodContext,
  mockReq,
  mockRes,
} from "./_helpers";

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
          return res.json({ items: [1] });
        }
      }
      const D = Cacheable({ ttl: 5000 })(C as any);
      const i = new D();
      const req = mockReq();

      const r1 = mockRes({ locals: { entity: "1" } });
      await i.get(req, r1);
      expect(r1._headers["X-Cache"]).toBe("MISS");

      const r2 = mockRes({ locals: { entity: "1" } });
      await i.get(req, r2);
      expect(r2._headers["X-Cache"]).toBe("HIT");
      expect(r2._body).toEqual({ items: [1] });
    });

    test("write invalida cache", async () => {
      class C {
        async get(req: any, res: any) {
          return res.json({ ok: 1 });
        }
        async create(req: any, res: any) {
          return res.json({ created: true });
        }
      }
      const D = Cacheable()(C as any);
      const i = new D();
      const req = mockReq();

      await i.get(req, mockRes({ locals: { entity: "1" } }));
      await i.create(req, mockRes({ locals: { entity: "1" } }));

      const r = mockRes({ locals: { entity: "1" } });
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
      CacheMethod({ ttl: 5000 })(S.prototype, "find", d);
      expect(warnCap.warnings.some((w) => w.includes("CacheMethod"))).toBe(true);
    });
  });

  describe("CacheMethod — TC39", () => {
    test("SEM warning e funciona cache HIT/MISS", async () => {
      let calls = 0;
      async function find(this: any, req: any, res: any) {
        calls++;
        return res.json({ data: "x" });
      }
      const wrapped = CacheMethod({ ttl: 5000 })(find, fakeMethodContext("find"));
      expect(warnCap.warnings.every((w) => !w.includes("CacheMethod"))).toBe(true);

      const ctx = { constructor: { name: "SvcTC39" } };
      const req = mockReq();

      const r1 = mockRes({ locals: { entity: "1" } });
      await wrapped.call(ctx, req, r1);
      expect(r1._headers["X-Cache"]).toBe("MISS");
      expect(calls).toBe(1);

      const r2 = mockRes({ locals: { entity: "1" } });
      await wrapped.call(ctx, req, r2);
      expect(r2._headers["X-Cache"]).toBe("HIT");
      expect(calls).toBe(1);
    });
  });

  describe("Cacheable — options cacheable/invalidate", () => {
    test("cacheia funções custom e invalida com funções custom", async () => {
      class C {
        async list(req: any, res: any) {
          return res.json({ items: [1] });
        }
        async save(req: any, res: any) {
          return res.json({ ok: true });
        }
      }
      const D = Cacheable({ cacheable: ["list"], invalidate: ["save"] })(
        C as any,
        fakeClassContext("C"),
      );
      const i = new D();
      const req = mockReq();

      const r1 = mockRes({ locals: { entity: "1" } });
      await i.list(req, r1);
      expect(r1._headers["X-Cache"]).toBe("MISS");

      const r2 = mockRes({ locals: { entity: "1" } });
      await i.list(req, r2);
      expect(r2._headers["X-Cache"]).toBe("HIT");

      await i.save(req, mockRes({ locals: { entity: "1" } }));

      const r3 = mockRes({ locals: { entity: "1" } });
      await i.list(req, r3);
      expect(r3._headers["X-Cache"]).toBe("MISS");
    });

    test("NÃO invalida quando a função de invalidação lança erro", async () => {
      class C {
        async get(req: any, res: any) {
          return res.json({ ok: 1 });
        }
        async create(_req: any, _res: any) {
          throw new Error("boom");
        }
      }
      const D = Cacheable()(C as any, fakeClassContext("C"));
      const i = new D();
      const req = mockReq();

      await i.get(req, mockRes({ locals: { entity: "1" } }));

      await expect(i.create(req, mockRes({ locals: { entity: "1" } }))).rejects.toThrow("boom");

      // Cache preservado porque o create falhou
      const r = mockRes({ locals: { entity: "1" } });
      await i.get(req, r);
      expect(r._headers["X-Cache"]).toBe("HIT");
    });
  });

  describe("CacheProvider (manual)", () => {
    test("add / get / has / invalidate por chave", () => {
      CacheProvider.add("k1", { v: 1 });
      expect(CacheProvider.has("k1")).toBe(true);
      expect(CacheProvider.get("k1")).toEqual({ v: 1 });

      expect(CacheProvider.invalidate("k1")).toBe(1);
      expect(CacheProvider.has("k1")).toBe(false);
    });

    test("get respeita expiração (ttl)", () => {
      CacheProvider.add("k-exp", 42, -1);
      expect(CacheProvider.get("k-exp")).toBeUndefined();
    });

    test("invalidate por prefixo (árvore de relatórios)", () => {
      CacheProvider.add("report-A-fn-tag|ent:1", 1);
      CacheProvider.add("report-A-fn-tag|ent:2", 2);
      CacheProvider.add("report-B-fn-tag|ent:1", 3);

      const removed = CacheProvider.invalidate("report-A-*");
      expect(removed).toBe(2);
      expect(CacheProvider.keys("report-B")).toHaveLength(1);
    });

    test("invalidate sem parâmetro limpa tudo", async () => {
      class S {
        async get(req: any, res: any) {
          return res.json(1);
        }
      }
      const D = Cacheable()(S as any, fakeClassContext("S"));
      await new D().get(mockReq(), mockRes({ locals: { entity: "1" } }));
      CacheProvider.add("k", 1);

      CacheProvider.invalidate();
      expect(getCacheStats()).toEqual({});
      expect(CacheProvider.has("k")).toBe(false);
    });
  });

  describe("@Cached (relatórios/valor de retorno, RLS via contexto)", () => {
    test("cacheia o valor de retorno e reusa na 2ª chamada", async () => {
      let calls = 0;

      async function gerar(this: any, filtros: any) {
        calls++;
        return { rows: [filtros.x] };
      }
      const wrapped = Cached({ tag: "boletim", ttl: 5000 })(gerar, fakeMethodContext("gerar"));

      const ctx = { constructor: { name: "BoletimController" } };
      const out1 = await wrapped.call(ctx, { x: 1 });
      const out2 = await wrapped.call(ctx, { x: 1 });

      expect(out1).toEqual({ rows: [1] });
      expect(out2).toEqual({ rows: [1] });
      expect(calls).toBe(1);

      // A chave segue o padrão report-<Classe>-<funcao>-<tag>
      const keys = CacheProvider.keys("report-BoletimController-gerar-boletim");
      expect(keys.length).toBeGreaterThanOrEqual(1);
    });

    test("args diferentes geram chaves diferentes", async () => {
      let calls = 0;
      async function gerar(this: any, filtros: any) {
        calls++;
        return filtros.x;
      }
      const wrapped = Cached({ tag: "t" })(gerar, fakeMethodContext("gerar"));
      const ctx = { constructor: { name: "Rel" } };

      await wrapped.call(ctx, { x: 1 });
      await wrapped.call(ctx, { x: 2 });
      expect(calls).toBe(2);
    });
  });

  describe("reportCacheKey", () => {
    test("monta a chave padronizada", () => {
      expect(reportCacheKey("BoletimController", "gerar", "boletim", "ent:1")).toBe(
        "report-BoletimController-gerar-boletim|ent:1",
      );
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
      await new D().get(mockReq(), mockRes({ locals: { entity: "1" } }));
      expect(getCacheStats()["S"]).toBeGreaterThanOrEqual(1);
      clearAllCache();
      expect(getCacheStats()).toEqual({});
    });
  });
});

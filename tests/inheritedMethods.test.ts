import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Auditable, setAuditStorage, type AuditEntry } from "../src/decorators/auditable";
import { Cacheable, clearAllCache } from "../src/decorators/cacheable";
import { setSavepointPolicy, TransactionalClass } from "../src/decorators/transactional";
import { captureLogs, captureWarnings, mockReq, mockRes } from "./_helpers";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const locals = () => mockRes({ locals: { userInfo: { id: "u1" }, entity: "1" } });

describe("decorators de classe enxergam os métodos herdados", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  let logCap: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    clearAllCache();
    setSavepointPolicy("always");
    warnCap = captureWarnings();
    logCap = captureLogs();
  });
  afterEach(() => {
    warnCap.restore();
    logCap.restore();
  });

  describe("@Cacheable", () => {
    const buildControllers = () => {
      let leituras = 0;
      class Base {
        async get(_req: any, res: any) {
          leituras += 1;
          return res.json({ leituras });
        }
        async create(_req: any, res: any) {
          return res.json({ ok: true });
        }
      }
      class Filho extends Base {}
      return { Base, Filho, getLeituras: () => leituras };
    };

    test("guarda o get herdado da classe base", async () => {
      const { Filho, getLeituras } = buildControllers();
      Cacheable({ ttl: 5000 })(Filho as any);
      const controller = new Filho();

      await controller.get(mockReq(), locals());
      const segunda = locals();
      await controller.get(mockReq(), segunda);

      expect(segunda._headers["X-Cache"]).toBe("HIT");
      expect(getLeituras()).toBe(1);
    });

    test("o create herdado invalida o cache", async () => {
      const { Filho, getLeituras } = buildControllers();
      Cacheable({ ttl: 5000 })(Filho as any);
      const controller = new Filho();

      await controller.get(mockReq(), locals());
      await controller.create(mockReq(), locals());
      await controller.get(mockReq(), locals());

      expect(getLeituras()).toBe(2);
    });

    test("base e filhos decorados: cada filho tem o próprio cache e o próprio ttl", async () => {
      const { Base, getLeituras } = buildControllers();
      class Rapido extends Base {}
      class Lento extends Base {}
      Cacheable({ ttl: 5000 })(Base as any);
      Cacheable({ ttl: 1 })(Rapido as any);
      Cacheable({ ttl: 5000 })(Lento as any);
      const lento = new Lento();

      await new Rapido().get(mockReq(), locals());
      await delay(10);
      await new Rapido().get(mockReq(), locals());
      expect(getLeituras()).toBe(2);

      await lento.get(mockReq(), locals());
      await new Rapido().create(mockReq(), locals());
      const depois = locals();
      await lento.get(mockReq(), depois);

      expect(depois._headers["X-Cache"]).toBe("HIT");
      expect(getLeituras()).toBe(3);
    });

    test("a classe base não é alterada", async () => {
      const { Base, Filho, getLeituras } = buildControllers();
      const getDaBase = Object.getOwnPropertyDescriptor(Base.prototype, "get")?.value;
      Cacheable({ ttl: 5000 })(Filho as any);
      const base = new Base();

      await base.get(mockReq(), locals());
      await base.get(mockReq(), locals());

      expect(Object.getOwnPropertyDescriptor(Base.prototype, "get")?.value).toBe(getDaBase);
      expect(getLeituras()).toBe(2);
    });
  });

  describe("@Auditable", () => {
    const buildControllers = () => {
      class Base {
        DAO = { tx: null };
        data = {};
        async create(_req: any, res: any) {
          return res.json({ data: { id: "1" } });
        }
      }
      class Filho extends Base {}
      return { Base, Filho };
    };

    test("audita o create herdado, com o nome da classe decorada", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => void entries.push(entry));
      const { Filho } = buildControllers();
      Auditable(Filho as any);

      await new Filho().create(mockReq({ params: { id: "1" } }), locals());
      await delay(50);

      expect(entries.map((entry) => entry.action)).toEqual(["CREATE"]);
      expect(JSON.stringify(entries[0])).toContain("Filho");
    });

    test("base e filho decorados: o registro sai com o nome e as opções do filho", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => void entries.push(entry));
      const { Base, Filho } = buildControllers();
      Auditable(Base as any);
      Auditable(Filho as any);

      await new Filho().create(mockReq({ params: { id: "1" } }), locals());
      await delay(50);

      expect(entries.map((entry) => entry.method)).toEqual(["Filho.create"]);
    });

    test("base com cache e auditoria, filho só auditado: audita uma vez e mantém o cache", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => void entries.push(entry));
      let leituras = 0;
      class Base {
        DAO = { tx: null };
        data = {};
        async get(_req: any, res: any) {
          leituras += 1;
          return res.json({ leituras });
        }
        async create(_req: any, res: any) {
          return res.json({ data: { id: "1" } });
        }
      }
      class Filho extends Base {}
      Auditable(Base as any);
      Cacheable({ ttl: 5000, invalidate: [] })(Base as any);
      Auditable(Filho as any);
      const controller = new Filho();

      await controller.get(mockReq(), locals());
      await controller.get(mockReq(), locals());
      await controller.create(mockReq({ params: { id: "1" } }), locals());
      await delay(50);

      expect(leituras).toBe(1);
      expect(entries.map((entry) => entry.method)).toEqual(["Filho.create"]);
    });

    test("base e filho decorados auditam uma vez só", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => void entries.push(entry));
      const { Base, Filho } = buildControllers();
      Auditable(Base as any);
      Auditable(Filho as any);

      await new Filho().create(mockReq({ params: { id: "1" } }), locals());
      await delay(50);

      expect(entries).toHaveLength(1);
    });
  });

  describe("@TransactionalClass", () => {
    const mockTx = () => {
      const calls: string[] = [];
      return { calls, $executeRawUnsafe: async (sql: string) => void calls.push(sql) };
    };

    test("o create herdado roda dentro de SAVEPOINT", async () => {
      const tx = mockTx();
      class Base {
        DAO = { tx };
        async create() {
          return { id: 1 };
        }
      }
      class Filho extends Base {}
      TransactionalClass(Filho as any);

      expect(await new Filho().create()).toEqual({ id: 1 });
      expect(tx.calls.map((sql) => sql.split(" ")[0])).toEqual(["SAVEPOINT", "RELEASE"]);
    });

    test("base e filho decorados abrem um SAVEPOINT só", async () => {
      const tx = mockTx();
      class Base {
        DAO = { tx };
        async create() {
          return { id: 1 };
        }
      }
      class Filho extends Base {}
      TransactionalClass(Base as any);
      TransactionalClass(Filho as any);

      await new Filho().create();
      expect(tx.calls.filter((sql) => sql.startsWith("SAVEPOINT"))).toHaveLength(1);
    });

    test("método próprio do filho continua envolvido", async () => {
      const tx = mockTx();
      class Base {
        DAO = { tx };
        async create() {
          return { id: 1 };
        }
      }
      class Filho extends Base {
        override async create() {
          return { id: 2 };
        }
      }
      TransactionalClass(Filho as any);

      expect(await new Filho().create()).toEqual({ id: 2 });
      expect(tx.calls.filter((sql) => sql.startsWith("SAVEPOINT"))).toHaveLength(1);
    });
  });
});

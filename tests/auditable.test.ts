import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearLegacyWarnings } from "../src/decorators/_proxy";
import { Auditable, setAuditStorage, type AuditEntry } from "../src/decorators/auditable";
import { captureLogs, captureWarnings, fakeClassContext, mockReq, mockRes } from "./_helpers";

describe("Auditable", () => {
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

  describe("Legacy", () => {
    test("emite warning e intercepta create", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => entries.push(entry));

      class Ctrl {
        DAO = { tx: null };
        data = {};
        async create(req: any, res: any) {
          return res.json({ data: { id: "1" } });
        }
      }
      const D = Auditable(Ctrl as any);
      expect(warnCap.warnings.some((w) => w.includes("LEGACY"))).toBe(false);

      const i = new D();
      await i.create(
        mockReq({ params: { id: "1" } }),
        mockRes({ locals: { userInfo: { id: "u1" }, entity: 1 } }),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(entries.length).toBe(1);
      expect(entries[0]!.action).toBe("CREATE");
    });

    test("intercepta update e delete", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => entries.push(entry));

      class Ctrl {
        DAO = { tx: null };
        data = {};
        async update(req: any, res: any) {
          return res.json({ data: { id: "2" } });
        }
        async deleteById(req: any, res: any) {
          return res.json({ ok: true });
        }
      }
      Auditable(Ctrl as any);
      const i = new Ctrl();
      await i.update(mockReq(), mockRes({ locals: { userInfo: { id: "u" }, entity: 1 } }));
      await i.deleteById(mockReq(), mockRes({ locals: { userInfo: { id: "u" }, entity: 1 } }));
      await new Promise((r) => setTimeout(r, 50));
      expect(entries.length).toBe(2);
      expect(entries[0]!.action).toBe("UPDATE");
      expect(entries[1]!.action).toBe("DELETE");
    });
  });

  describe("TC39", () => {
    test("SEM warning com context", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => entries.push(entry));

      class Ctrl {
        DAO = { tx: null };
        data = {};
        async create(req: any, res: any) {
          return res.json({ data: { id: "3" } });
        }
      }
      Auditable(Ctrl as any, fakeClassContext("Ctrl"));
      expect(warnCap.warnings.filter((w) => w.includes("Auditable")).length).toBe(0);
    });
  });

  describe("estado anterior (before)", () => {
    function ctrlComTx(before: any) {
      const buscas: any[] = [];
      const tx = {
        conta: {
          findUnique: async (args: any) => {
            buscas.push(args);
            return before;
          },
        },
      };

      class ContaController {
        DAO = { tx };
        data = { valor: 10 };
        async update(_req: any, res: any) {
          return res.json({ data: { id: "7" } });
        }
      }

      return { ContaController, buscas };
    }

    test("por PADRÃO busca o registro antigo — comportamento histórico", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => entries.push(entry));

      const { ContaController, buscas } = ctrlComTx({ id: "7", valor: 1 });
      Auditable(ContaController as any);

      await new ContaController().update(
        mockReq({ params: { id: "7" }, body: { valor: 99 } }),
        mockRes({ locals: { userInfo: { id: "u" }, entity: 1 } }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(buscas.length).toBe(1);
      expect(entries[0]!.before).toEqual({ id: "7", valor: 1 });
    });

    test("captureBefore: false poupa a consulta e deixa o before nulo", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => entries.push(entry));

      const { ContaController, buscas } = ctrlComTx({ id: "7", valor: 1 });
      Auditable({ captureBefore: false })(ContaController as any);

      await new ContaController().update(
        mockReq({ params: { id: "7" }, body: { valor: 99 } }),
        mockRes({ locals: { userInfo: { id: "u" }, entity: 1 } }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(buscas.length).toBe(0);
      expect(entries[0]!.before).toBe(null);
    });

    test("sem resposta capturada, o after cai no body da requisição", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => entries.push(entry));

      class Ctrl {
        DAO = { tx: null };
        async update(_req: any, res: any) {
          res.statusCode = 204;
          return res;
        }
      }
      Auditable(Ctrl as any);

      await new Ctrl().update(
        mockReq({ params: { id: "1" }, body: { nome: "Ana" } }),
        mockRes({ locals: { entity: 1 } }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(entries[0]!.after).toEqual({ nome: "Ana" });
    });

    test("a fábrica com options não exige argumento nenhum", async () => {
      const entries: AuditEntry[] = [];
      setAuditStorage(async (entry) => entries.push(entry));

      class Ctrl {
        DAO = { tx: null };
        async create(_req: any, res: any) {
          return res.json({ data: { id: "9" } });
        }
      }
      Auditable()(Ctrl as any);

      await new Ctrl().create(mockReq(), mockRes({ locals: { entity: 2 } }));
      await new Promise((r) => setTimeout(r, 20));

      expect(entries[0]!.action).toBe("CREATE");
      expect(entries[0]!.entityId).toBe("9");
    });
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearLegacyWarnings } from "../src/decorators/_proxy";
import {
  Auditable,
  flushAuditReads,
  resetAuditStorage,
  setAuditStorage,
  type AuditEntry,
} from "../src/decorators/auditable";
import {
  clearTransactionalCompanyFn,
  setTransactionalCompanyFn,
} from "../src/decorators/transactional";
import { clearPrismaClient, setPrismaClient } from "../src/handlers/prisma";
import { captureErrors, captureLogs, captureWarnings, mockReq, mockRes } from "./_helpers";

const settle = () => new Promise((r) => setTimeout(r, 10));

function buildFolhaController() {
  class FolhaController {
    DAO = { tx: { marcador: "tx-da-requisicao" } };
    async getById(req: any, res: any) {
      return res.json({ data: { id: req.params.id, salario: 9000, cpf: "123.456.789-00" } });
    }
    async get(_req: any, res: any) {
      return res.json({
        data: [
          { id: "1", salario: 1 },
          { id: "2", salario: 2 },
        ],
        total: 2,
      });
    }
    async update(_req: any, res: any) {
      return res.json({ data: { id: "7" } });
    }
  }
  return FolhaController;
}

const userRes = (overrides: Record<string, any> = {}) =>
  mockRes({ locals: { userInfo: { id: "u-9" }, entity: 3 }, ...overrides });

describe("@Auditable: leitura", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  let logCap: ReturnType<typeof captureLogs>;
  const entries: AuditEntry[] = [];
  const txs: unknown[] = [];

  beforeEach(() => {
    clearLegacyWarnings();
    warnCap = captureWarnings();
    logCap = captureLogs();
    entries.length = 0;
    txs.length = 0;
    setAuditStorage(async (entry, tx) => {
      entries.push(entry);
      txs.push(tx);
    });
  });
  afterEach(() => {
    warnCap.restore();
    logCap.restore();
    resetAuditStorage();
  });

  test("sem a opção read, a leitura não é auditada", async () => {
    const Ctrl = buildFolhaController();
    Auditable(Ctrl as any);

    await new Ctrl().getById(mockReq({ params: { id: "f-1" } }), userRes());
    await settle();

    expect(entries).toEqual([]);
  });

  test("read: true registra o getById como READ, sem o conteúdo lido e sem a transação", async () => {
    const Ctrl = buildFolhaController();
    Auditable({ read: true })(Ctrl as any);

    const res = userRes();
    await new Ctrl().getById(mockReq({ params: { id: "f-1" }, ip: "10.0.0.1" }), res);
    await settle();

    expect(res._body.data.salario).toBe(9000);
    expect(entries.length).toBe(1);
    const [entry] = entries;
    expect(entry!.action).toBe("READ");
    expect(entry!.entity).toBe("Folha");
    expect(entry!.entityId).toBe("f-1");
    expect(entry!.userId).toBe("u-9");
    expect(entry!.entidade).toBe(3);
    expect(entry!.method).toBe("FolhaController.getById");
    expect(entry!.ip).toBe("10.0.0.1");
    expect(entry!.before).toBe(null);
    expect(entry!.after).toBe(null);
    expect(JSON.stringify(entry)).not.toContain("9000");
    expect(txs[0]).toBeUndefined();
  });

  test("read: true não audita a listagem", async () => {
    const Ctrl = buildFolhaController();
    Auditable({ read: true })(Ctrl as any);

    await new Ctrl().get(mockReq(), userRes());
    await settle();

    expect(entries).toEqual([]);
  });

  test("listagem nomeada em read gera UMA entrada por requisição, com o filtro e sem as linhas", async () => {
    const Ctrl = buildFolhaController();
    Auditable({ read: ["getById", "get"] })(Ctrl as any);

    await new Ctrl().get(mockReq({ query: { cpf: "123", page: "1" } }), userRes());
    await settle();

    expect(entries.length).toBe(1);
    expect(entries[0]!.action).toBe("READ");
    expect(entries[0]!.entityId).toBe(null);
    expect(entries[0]!.after).toEqual({ query: { cpf: "123", page: "1" } });
    expect(JSON.stringify(entries[0])).not.toContain("salario");
  });

  test("listagem sem filtro deixa o after nulo", async () => {
    const Ctrl = buildFolhaController();
    Auditable({ read: ["get"] })(Ctrl as any);

    await new Ctrl().get(mockReq(), userRes());
    await settle();

    expect(entries[0]!.after).toBe(null);
  });

  test("leitura recusada (status 400 ou mais) não é registrada", async () => {
    class Ctrl {
      async getById(_req: any, res: any) {
        return res.status(404).json({ message: "Não encontrado." });
      }
    }
    Auditable({ read: true })(Ctrl as any);

    await new Ctrl().getById(mockReq({ params: { id: "x" } }), userRes());
    await settle();

    expect(entries).toEqual([]);
  });

  test("leitura que lança não é registrada e o erro chega a quem chamou", async () => {
    class Ctrl {
      async getById() {
        throw new Error("falhou");
      }
    }
    Auditable({ read: true })(Ctrl as any);

    await expect(new Ctrl().getById()).rejects.toThrow("falhou");
    expect(entries).toEqual([]);
  });

  test("destino que falha não derruba a leitura", async () => {
    setAuditStorage(async () => {
      throw new Error("destino fora do ar");
    });
    const Ctrl = buildFolhaController();
    Auditable({ read: true })(Ctrl as any);

    const res = userRes();
    await new Ctrl().getById(mockReq({ params: { id: "f-1" } }), res);
    await settle();

    expect(res._body.data.id).toBe("f-1");
  });

  test("método de escrita em read continua auditado como escrita", async () => {
    const Ctrl = buildFolhaController();
    Auditable({ read: ["update"], captureBefore: false })(Ctrl as any);

    await new Ctrl().update(mockReq({ params: { id: "7" } }), userRes());
    await settle();

    expect(entries.map((e) => e.action)).toEqual(["UPDATE"]);
    expect(txs[0]).toEqual({ marcador: "tx-da-requisicao" });
  });
});

describe("@Auditable: leitura no destino padrão", () => {
  let logCap: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    logCap = captureLogs();
    resetAuditStorage();
  });
  afterEach(async () => {
    await flushAuditReads();
    logCap.restore();
    clearPrismaClient();
    clearTransactionalCompanyFn();
  });

  function fakePrisma7() {
    const transactions: Array<{ sql: string[]; company: string[] }> = [];
    const client = {
      $transaction: async (fn: (tx: any) => any) => {
        const atual = { sql: [] as string[], company: [] as string[] };
        transactions.push(atual);
        return fn({
          $executeRawUnsafe: async (sql: string) => {
            atual.sql.push(sql);
            return 1;
          },
          atual,
        });
      },
    };
    return { client, transactions };
  }

  test("grava as leituras em lote, sem a transação da requisição, uma transação por entidade", async () => {
    const { client, transactions } = fakePrisma7();
    setPrismaClient(client);
    setTransactionalCompanyFn((tx, entity) => tx.atual.company.push(String(entity)));

    const Ctrl = buildFolhaController();
    Auditable({ read: true })(Ctrl as any);

    const ctrl = new Ctrl();
    await ctrl.getById(mockReq({ params: { id: "a" } }), userRes());
    await ctrl.getById(mockReq({ params: { id: "b" } }), userRes());
    await ctrl.getById(
      mockReq({ params: { id: "c" } }),
      mockRes({ locals: { userInfo: { id: "u-1" }, entity: 5 } }),
    );
    expect(transactions.length).toBe(0);

    await flushAuditReads();

    expect(transactions.length).toBe(2);
    const [ent3, ent5] = transactions;
    expect(ent3!.company).toEqual(["3"]);
    expect(ent5!.company).toEqual(["5"]);
    expect(ent3!.sql.length).toBe(1);
    expect(ent3!.sql[0]).toContain(`INSERT INTO "audit_log"`);
    expect(ent3!.sql[0]).toContain("'READ'");
    expect(ent3!.sql[0]).toContain("'a'");
    expect(ent3!.sql[0]).toContain("'b'");
    expect(ent3!.sql[0]).not.toContain("9000");
    expect(ent5!.sql[0]).toContain("'c'");
  });

  test("sem client configurado, a leitura segue e a auditoria só avisa", async () => {
    clearPrismaClient();
    const Ctrl = buildFolhaController();
    Auditable({ read: true })(Ctrl as any);

    const warnCap = captureWarnings();
    const res = userRes();
    try {
      await new Ctrl().getById(mockReq({ params: { id: "a" } }), res);
      await flushAuditReads();
    } finally {
      warnCap.restore();
    }

    expect(res._body.data.id).toBe("a");
    expect(warnCap.warnings.some((w) => w.includes("setPrismaClient"))).toBe(true);
  });

  test("falha do banco ao gravar o lote não lança", async () => {
    setPrismaClient({
      $transaction: async () => {
        throw new Error("banco fora do ar");
      },
    });
    const Ctrl = buildFolhaController();
    Auditable({ read: true })(Ctrl as any);

    const { errors, restore } = captureErrors();
    try {
      await new Ctrl().getById(mockReq({ params: { id: "a" } }), userRes());
      await expect(flushAuditReads()).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(errors.some((l) => l.includes("banco fora do ar"))).toBe(true);
  });

  test("o lote cheio grava sem esperar o intervalo", async () => {
    const { client, transactions } = fakePrisma7();
    setPrismaClient(client);
    const Ctrl = buildFolhaController();
    Auditable({ read: true })(Ctrl as any);

    const ctrl = new Ctrl();
    for (let i = 0; i < 100; i++) {
      await ctrl.getById(mockReq({ params: { id: `id-${i}` } }), userRes());
    }
    await settle();

    expect(transactions.length).toBe(1);
  });
});

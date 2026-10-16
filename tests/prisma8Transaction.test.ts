import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearLegacyWarnings } from "../src/decorators/_proxy";
import { Auditable, setAuditStorage, type AuditEntry } from "../src/decorators/auditable";
import { setSavepointPolicy, TransactionalClass } from "../src/decorators/transactional";
import { addCompanyIdToTransaction } from "../src/functions/sql";
import { runInTransaction } from "../src/handlers/prisma";
import {
  configurePrisma8,
  isPrisma7Tx,
  isPrisma8Tx,
  resetPrisma8,
  runStatement,
} from "../src/prisma8/client";
import {
  FakeCollection,
  fakeCombinators,
  fakeDb8,
  fakeTx8,
  type FakeContractModels,
} from "../src/testing/prisma8Fakes";
import { captureLogs, captureWarnings, fakeClassContext, mockReq, mockRes } from "./_helpers";

const models: FakeContractModels = { Bairro: { fields: ["id", "name"] } };

describe("detecção do client", () => {
  test("Prisma 7 tem $executeRawUnsafe; Prisma 8 tem execute/query/orm", () => {
    expect(isPrisma7Tx({ $executeRawUnsafe: async () => 0 })).toBe(true);
    expect(isPrisma7Tx(fakeTx8(models))).toBe(false);
    expect(isPrisma8Tx(fakeTx8(models))).toBe(true);
    expect(isPrisma8Tx({})).toBe(false);
    expect(isPrisma8Tx(undefined)).toBe(false);
  });
});

describe("runStatement / addCompanyIdToTransaction", () => {
  beforeEach(() => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
  });

  test("no Prisma 7 vai por $executeRawUnsafe", async () => {
    const sqls: unknown[][] = [];
    const tx7 = {
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => (
        sqls.push([sql, ...params]),
        1
      ),
    };
    await addCompanyIdToTransaction(tx7, "79");
    expect(sqls).toEqual([["SELECT set_config('my.company_id', $1, true)", "79"]]);
  });

  test("no Prisma 8 vira plano cru executado na transação", async () => {
    const tx8 = fakeTx8(models);
    await addCompanyIdToTransaction(tx8, "79");
    expect(tx8.statements).toEqual(["SELECT set_config('my.company_id', ?, true)"]);
    expect(tx8.plans[0]).toMatchObject({ values: ["79"] });
    await runStatement(tx8, 'SAVEPOINT "sp_1"');
    expect(tx8.statements[1]).toBe('SAVEPOINT "sp_1"');
  });

  test("Prisma 8 sem configurePrisma8 falha explicando", async () => {
    resetPrisma8();
    await expect(runStatement(fakeTx8(models), "SELECT 1")).rejects.toThrow(/configurePrisma8/);
  });

  test("objeto que não é transação de nenhum dos dois falha alto", async () => {
    await expect(runStatement({}, "SELECT 1")).rejects.toThrow(/transação/);
  });
});

describe("runInTransaction — fachada dos dois clients", () => {
  test("Prisma 7 recebe as opções; Prisma 8 só o callback", async () => {
    const seen: unknown[] = [];
    const p7 = {
      $transaction: async (fn: (tx: unknown) => unknown, options: unknown) => (
        seen.push(options),
        fn("tx7")
      ),
    };
    const p8 = { transaction: async (fn: (tx: unknown) => unknown) => fn("tx8") };
    expect(await runInTransaction(p7, async (tx) => tx, { timeout: 5 })).toBe("tx7");
    expect(seen).toEqual([{ timeout: 5 }]);
    expect(await runInTransaction(p8 as any, async (tx) => tx, { timeout: 5 })).toBe("tx8");
  });
});

describe("@TransactionalClass com transação do Prisma 8", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  beforeEach(() => {
    clearLegacyWarnings();
    warnCap = captureWarnings();
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
    setSavepointPolicy("always");
  });
  afterEach(() => {
    warnCap.restore();
    setSavepointPolicy("always");
  });

  test("abre, libera e reverte savepoint pelo lado cru do Prisma 8", async () => {
    const tx = fakeTx8(models);
    class Ctrl {
      DAO = { tx };
      async create() {
        return "ok";
      }
      async update() {
        throw new Error("falhou");
      }
    }
    const D = TransactionalClass(Ctrl as any, fakeClassContext("Ctrl"));
    const instance = new D();
    expect(await instance.create()).toBe("ok");
    await expect(instance.update()).rejects.toThrow("falhou");
    expect(tx.statements.map((s) => s.replace(/sp_\w+_\d+/, "sp"))).toEqual([
      'SAVEPOINT "sp"',
      'RELEASE SAVEPOINT "sp"',
      'SAVEPOINT "sp"',
      'ROLLBACK TO SAVEPOINT "sp"',
    ]);
  });
});

describe("@Auditable lê o estado anterior pelo Prisma 8", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  let logCap: ReturnType<typeof captureLogs>;
  beforeEach(() => {
    clearLegacyWarnings();
    warnCap = captureWarnings();
    logCap = captureLogs();
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
  });
  afterEach(() => {
    warnCap.restore();
    logCap.restore();
  });

  test("before vem de orm.public.<Model>.where({ id }).first()", async () => {
    const bairros = new FakeCollection(models, "Bairro", { rows: [{ id: "1", name: "antes" }] });
    const tx = fakeTx8(models, { Bairro: bairros });
    const entries: AuditEntry[] = [];
    setAuditStorage(async (entry) => entries.push(entry));

    class BairroController {
      DAO = { tx };
      async update(_req: unknown, res: any) {
        return res.json({ data: { id: "1", name: "depois" } });
      }
    }
    const D = Auditable(BairroController as any, fakeClassContext("BairroController"));
    await new D().update(
      mockReq({ params: { id: "1" } }),
      mockRes({ locals: { userInfo: { id: "u1" }, entity: 79 } }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(bairros.calls[0]?.state.where).toEqual([{ op: "eqObject", value: { id: "1" } }]);
    expect(entries[0]?.before).toEqual({ id: "1", name: "antes" });
    expect(entries[0]?.after).toEqual({ id: "1", name: "depois" });
  });
});

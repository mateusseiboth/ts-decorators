import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setTransactionalCompanyFn } from "../src/decorators/transactional";
import { addCompanyIdToTransaction } from "../src/functions/sql";
import {
  defaultCompanyIdInjector,
  getCompanyIdInjector,
  noopCompanyIdInjector,
  resetCompanyIdInjector,
  setCompanyIdInjector,
} from "../src/handlers/companyId";
import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import {
  fakeCombinators,
  fakeDb8,
  fakeTx8,
  type FakeContractModels,
} from "../src/testing/prisma8Fakes";
import { captureLogs } from "./_helpers";

/**
 * Estratégia de tenant (RLS) injetável. O padrão fixa `my.company_id` com `set_config`, sempre
 * PARAMETRIZADO, na transação do Prisma 7 ou do Prisma 8. Sem banco: transações fake.
 */
const SET_CONFIG = "SELECT set_config('my.company_id', $1, true)";
const UUID = "019ffadb-aa94-7138-888a-d4ceabd3c2c1";
const models: FakeContractModels = { Bairro: { fields: ["id", "name"] } };

describe("companyId injector", () => {
  let logCap: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    resetCompanyIdInjector();
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
    logCap = captureLogs();
  });
  afterEach(() => {
    logCap.restore();
    resetCompanyIdInjector();
    resetPrisma8();
  });

  function mockTx() {
    const calls: unknown[][] = [];
    return {
      calls,
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        calls.push([sql, ...params]);
      },
    };
  }

  test("padrão no Prisma 7: set_config com o id como parâmetro", async () => {
    const tx = mockTx();
    await addCompanyIdToTransaction(tx, "42");
    expect(tx.calls).toEqual([[SET_CONFIG, "42"]]);
  });

  test("id UUID vai como veio, sem virar número", async () => {
    const tx = mockTx();
    await addCompanyIdToTransaction(tx, UUID);
    expect(tx.calls).toEqual([[SET_CONFIG, UUID]]);
  });

  test("id numérico vai como texto (compatível com o SET LOCAL antigo)", async () => {
    const tx = mockTx();
    await addCompanyIdToTransaction(tx, 42);
    expect(tx.calls).toEqual([[SET_CONFIG, "42"]]);
  });

  test("id com aspas não entra no texto do SQL", async () => {
    const tx = mockTx();
    await addCompanyIdToTransaction(tx, "1'; DROP TABLE x; --");
    expect(tx.calls).toEqual([[SET_CONFIG, "1'; DROP TABLE x; --"]]);
  });

  test("padrão no Prisma 8: plano cru com o id como valor interpolado", async () => {
    const tx8 = fakeTx8(models);
    await addCompanyIdToTransaction(tx8, UUID);
    expect(tx8.plans).toEqual([
      { sql: "SELECT set_config('my.company_id', ?, true)", values: [UUID], kind: "execute" },
    ]);
  });

  test("Prisma 8 sem configurePrisma8 falha explicando", async () => {
    resetPrisma8();
    await expect(defaultCompanyIdInjector(fakeTx8(models), "1")).rejects.toThrow(
      /configurePrisma8/,
    );
  });

  test("objeto que não é transação de nenhum dos dois falha alto", async () => {
    await expect(defaultCompanyIdInjector({}, "1")).rejects.toThrow(/transação/);
  });

  test("estratégia customizada substitui a padrão", async () => {
    const tx = mockTx();
    const received: Array<[any, string | number]> = [];
    setCompanyIdInjector(async (t, companyId) => {
      received.push([t, companyId]);
      await t.$executeRawUnsafe("SELECT set_config('app.tenant', $1, true)", companyId);
    });

    await addCompanyIdToTransaction(tx, "7");

    expect(tx.calls).toEqual([["SELECT set_config('app.tenant', $1, true)", "7"]]);
    expect(received[0]?.[1]).toBe("7");
  });

  test("injector pontual tem precedência sobre o global", async () => {
    const tx = mockTx();
    setCompanyIdInjector((t) => t.$executeRawUnsafe("GLOBAL"));

    await addCompanyIdToTransaction(tx, "1", (t) => t.$executeRawUnsafe("LOCAL"));

    expect(tx.calls).toEqual([["LOCAL"]]);
  });

  test("noopCompanyIdInjector desliga a injeção", async () => {
    const tx = mockTx();
    setCompanyIdInjector(noopCompanyIdInjector);
    await addCompanyIdToTransaction(tx, "9");
    expect(tx.calls).toEqual([]);
  });

  test("reset volta para a estratégia padrão", async () => {
    const tx = mockTx();
    setCompanyIdInjector(noopCompanyIdInjector);
    resetCompanyIdInjector();
    await addCompanyIdToTransaction(tx, "3");
    expect(tx.calls).toEqual([[SET_CONFIG, "3"]]);
  });

  test("rejeita valor que não é função", () => {
    expect(() => setCompanyIdInjector("nope" as any)).toThrow();
    expect(getCompanyIdInjector()).toBeTypeOf("function");
  });

  test("setTransactionalCompanyFn continua isolado do injector global", async () => {
    const tx = mockTx();
    setTransactionalCompanyFn(async (t: any) => {
      await t.$executeRawUnsafe("LEGACY");
    });
    await addCompanyIdToTransaction(tx, "5");
    expect(tx.calls).toEqual([[SET_CONFIG, "5"]]);
  });
});

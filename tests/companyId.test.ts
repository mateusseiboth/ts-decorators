import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {setTransactionalCompanyFn} from "../src/decorators/transactional";
import {addCompanyIdToTransaction} from "../src/functions/sql";
import {getCompanyIdInjector, noopCompanyIdInjector, resetCompanyIdInjector, setCompanyIdInjector} from "../src/handlers/companyId";
import {captureLogs} from "./_helpers";

describe("companyId injector", () => {
  let logCap: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    resetCompanyIdInjector();
    logCap = captureLogs();
  });
  afterEach(() => {
    logCap.restore();
    resetCompanyIdInjector();
  });

  function mockTx() {
    const calls: string[] = [];
    return {
      calls,
      $executeRawUnsafe: async (sql: string) => {
        calls.push(sql);
      },
    };
  }

  test("usa SET LOCAL my.company_id por padrão", async () => {
    const tx = mockTx();
    await addCompanyIdToTransaction(tx, "42");
    expect(tx.calls).toEqual(['SET LOCAL "my.company_id" = 42']);
  });

  test("estratégia customizada substitui a padrão", async () => {
    const tx = mockTx();
    const received: Array<[any, string]> = [];
    setCompanyIdInjector(async (t, companyId) => {
      received.push([t, companyId]);
      await t.$executeRawUnsafe(`SELECT set_config('app.tenant', '${companyId}', true)`);
    });

    await addCompanyIdToTransaction(tx, "7");

    expect(tx.calls).toEqual(["SELECT set_config('app.tenant', '7', true)"]);
    expect(received[0]?.[1]).toBe("7");
  });

  test("injector pontual tem precedência sobre o global", async () => {
    const tx = mockTx();
    setCompanyIdInjector((t) => t.$executeRawUnsafe("GLOBAL"));

    await addCompanyIdToTransaction(tx, "1", (t) => t.$executeRawUnsafe("LOCAL"));

    expect(tx.calls).toEqual(["LOCAL"]);
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
    expect(tx.calls).toEqual(['SET LOCAL "my.company_id" = 3']);
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
    expect(tx.calls).toEqual(['SET LOCAL "my.company_id" = 5']);
  });
});

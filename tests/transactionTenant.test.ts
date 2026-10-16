import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/**
 * O tenant (RLS) entra na transação pelos três caminhos do pacote: o handler `Transactional`
 * (e o `withTransaction`), que usam a estratégia global de `setCompanyIdInjector`, e o
 * middleware `Transactional(prisma)`, opt-in por `setTransactionalCompanyFn`. Os três aceitam
 * `companyIdInjector` por rota. Prisma 7 e Prisma 8 fake, sem banco.
 */
import { setTransactionalCompanyFn, Transactional } from "../src/decorators/transactional";
import { resetCompanyIdInjector, setCompanyIdInjector } from "../src/handlers/companyId";
import { setHandlerContext } from "../src/handlers/context";
import { setPrismaClient } from "../src/handlers/prisma";
import { Transactional as TransactionalHandler } from "../src/handlers/Transactional";
import { withTransaction } from "../src/handlers/withTransaction";
import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import { fakeCombinators, fakeDb8, fakeTx8 } from "../src/testing/prisma8Fakes";
import { captureLogs, mockNext, mockReq, mockRes } from "./_helpers";

const SET_CONFIG = "SELECT set_config('my.company_id', $1, true)";

function fakeTx7() {
  const calls: unknown[][] = [];
  return {
    calls,
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      calls.push([sql, ...params]);
      return 1;
    },
  };
}

function fakeClient7(tx: ReturnType<typeof fakeTx7>) {
  return { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
}

describe("handler Transactional / withTransaction", () => {
  let logs: ReturnType<typeof captureLogs>;
  let ctx: Record<string, any>;

  beforeEach(() => {
    logs = captureLogs();
    ctx = { entity: "019ffadb-aa94-7138-888a-d4ceabd3c2c1" };
    setHandlerContext(() => ctx);
    resetCompanyIdInjector();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
  });
  afterEach(() => {
    logs.restore();
    setHandlerContext(() => undefined);
    resetCompanyIdInjector();
    resetPrisma8();
  });

  test("Prisma 7: fixa o tenant do contexto com a estratégia global", async () => {
    const tx = fakeTx7();
    setPrismaClient(fakeClient7(tx));

    await TransactionalHandler()(async () => undefined)(mockReq(), mockRes(), mockNext());

    expect(tx.calls).toEqual([[SET_CONFIG, ctx.entity]]);
    expect(ctx.transaction).toBe(tx);
  });

  test("Prisma 8: o mesmo tenant vai como plano parametrizado", async () => {
    const tx = fakeTx8({});
    setPrismaClient({ transaction: async (fn) => fn(tx) });

    await TransactionalHandler()(async () => undefined)(mockReq(), mockRes(), mockNext());

    expect(tx.plans).toEqual([
      { sql: "SELECT set_config('my.company_id', ?, true)", values: [ctx.entity], kind: "execute" },
    ]);
  });

  test("companyIdInjector da rota vence a estratégia global", async () => {
    const tx = fakeTx7();
    setPrismaClient(fakeClient7(tx));
    setCompanyIdInjector((t) => t.$executeRawUnsafe("GLOBAL"));

    await withTransaction(async () => undefined, undefined, {
      companyIdInjector: (t, id) => t.$executeRawUnsafe("ROTA", id),
    })(mockReq(), mockRes({ send: () => undefined }), mockNext());

    expect(tx.calls).toEqual([["ROTA", ctx.entity]]);
  });
});

describe("middleware Transactional(prisma)", () => {
  beforeEach(() => setTransactionalCompanyFn(null));
  afterEach(() => setTransactionalCompanyFn(null));

  /** Resposta que dispara `finish` assim que o próximo handler é chamado. */
  function runMiddleware(prisma: unknown, options?: Parameters<typeof Transactional>[1]) {
    const listeners: Record<string, () => void> = {};
    const res = mockRes({
      locals: { entity: 7 },
      on(event: string, fn: () => void) {
        listeners[event] = fn;
        return res;
      },
    });
    return new Promise<void>((resolve) => {
      Transactional(prisma as any, options)(mockReq(), res, () => {
        listeners.finish?.();
        setTimeout(resolve, 0);
      });
    });
  }

  test("sem setTransactionalCompanyFn nem opção, nada é injetado", async () => {
    const tx = fakeTx7();
    await runMiddleware(fakeClient7(tx));
    expect(tx.calls).toEqual([]);
  });

  test("companyIdInjector da rota vence o setTransactionalCompanyFn", async () => {
    const tx = fakeTx7();
    setTransactionalCompanyFn((t) => t.$executeRawUnsafe("LEGACY"));

    await runMiddleware(fakeClient7(tx), {
      companyIdInjector: (t, id) => t.$executeRawUnsafe("ROTA", id),
    });

    expect(tx.calls).toEqual([["ROTA", 7]]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CacheProvider } from "../src/decorators/cacheable";
import { addCompanyIdToTransaction, executePrismaQuery } from "../src/functions/sql";
import { getCompanyIdInjector, resetCompanyIdInjector } from "../src/handlers/companyId";
import {
  getTenantScope,
  resetTenantScope,
  setHandlerContext,
  setTenantScope,
} from "../src/handlers/context";
import {
  applyTransactionGucs,
  configureTenantGucs,
  createGucsInjector,
  resetTenantGucs,
} from "../src/handlers/tenantGucs";
import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import { fakeCombinators, fakeDb8, fakeTx8 } from "../src/testing/prisma8Fakes";

const mockTx7 = () => {
  const calls: unknown[][] = [];
  return {
    calls,
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      calls.push([sql, ...params]);
    },
  };
};

let contexto: Record<string, any> = {};

beforeEach(() => {
  contexto = {};
  setHandlerContext(() => contexto);
  resetPrisma8();
  configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
});

afterEach(() => {
  resetTenantGucs();
  resetTenantScope();
  resetCompanyIdInjector();
  resetPrisma8();
  setHandlerContext(() => undefined);
});

describe("applyTransactionGucs", () => {
  test("Prisma 7: um set_config por GUC, num comando só e parametrizado", async () => {
    const tx = mockTx7();
    await applyTransactionGucs(tx, {
      "app.conta_id": "c-1",
      "app.academia_id": 7,
      "app.is_super_admin": false,
    });
    expect(tx.calls).toEqual([
      [
        "SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true)",
        "app.conta_id",
        "c-1",
        "app.academia_id",
        "7",
        "app.is_super_admin",
        "false",
      ],
    ]);
  });

  test("Prisma 8: plano cru com nomes e valores como parâmetros", async () => {
    const tx8 = fakeTx8({});
    await applyTransactionGucs(tx8, { "app.conta_id": "c-1", "app.rede_id": null });
    expect(tx8.plans).toEqual([
      {
        sql: "SELECT set_config(?, ?, true), set_config(?, ?, true)",
        values: ["app.conta_id", "c-1", "app.rede_id", ""],
        kind: "execute",
      },
    ]);
  });

  test("undefined fica de fora; sem GUC nenhum, não vai ao banco", async () => {
    const tx = mockTx7();
    await applyTransactionGucs(tx, { "app.conta_id": undefined });
    expect(tx.calls).toEqual([]);
  });

  test("nome de GUC fora do padrão `prefixo.nome` é recusado", async () => {
    await expect(applyTransactionGucs(mockTx7(), { "conta; drop": "1" })).rejects.toThrow(
      "conta; drop",
    );
  });
});

describe("configureTenantGucs", () => {
  const resolve = (ctx: any) => ({
    "app.conta_id": ctx?.contaId,
    "app.academia_id": ctx?.academiaId,
    "app.is_super_admin": ctx?.superAdmin === true,
  });

  test("o addCompanyIdToTransaction passa a fixar as GUCs do contexto", async () => {
    configureTenantGucs(resolve);
    contexto = { contaId: "c-1", academiaId: "a-9" };
    const tx = mockTx7();

    await addCompanyIdToTransaction(tx, "ignorado");

    expect(tx.calls[0]?.slice(1)).toEqual([
      "app.conta_id",
      "c-1",
      "app.academia_id",
      "a-9",
      "app.is_super_admin",
      "false",
    ]);
  });

  test("o escopo do tenant (cache de contagem e @Cacheable) sai das mesmas GUCs", () => {
    configureTenantGucs(resolve);
    contexto = { contaId: "c-1", academiaId: "a-1" };
    const primeira = getTenantScope();
    contexto = { contaId: "c-1", academiaId: "a-2" };
    expect(getTenantScope()).not.toBe(primeira);
  });

  test("resetTenantGucs volta ao injetor padrão", () => {
    configureTenantGucs(resolve);
    resetTenantGucs();
    expect(getCompanyIdInjector().name).not.toBe("gucsInjector");
  });

  test("createGucsInjector serve direto ao setCompanyIdInjector", async () => {
    const injector = createGucsInjector(() => ({ "app.rede_id": "r-1" }));
    const tx = mockTx7();
    await injector(tx, "x");
    expect(tx.calls[0]?.slice(1)).toEqual(["app.rede_id", "r-1"]);
  });
});

describe("escopo do tenant", () => {
  test("padrão: a entity do contexto", () => {
    contexto = { entity: 42 };
    expect(getTenantScope()).toBe("42");
  });

  test("setTenantScope troca a origem do escopo", () => {
    setTenantScope(() => "conta:1|academia:2");
    expect(getTenantScope()).toBe("conta:1|academia:2");
  });

  test("a contagem memorizada de um tenant não serve a outro com a mesma entity", async () => {
    CacheProvider.clear?.();
    setTenantScope(() => `academia:${contexto.academiaId}`);
    const delegate = (total: number) => ({
      fields: { id: { modelName: "Aluno", name: "id" } },
      findMany: async () => [{ id: "1" }],
      count: async () => total,
    });
    const options = () => ({ where: {}, page: 1, skip: 0, take: 1, countTtlMs: 60_000 }) as any;

    contexto = { entity: 1, academiaId: "a-1" };
    const primeira: any = await executePrismaQuery(delegate(10) as any, options());
    contexto = { entity: 1, academiaId: "a-2" };
    const segunda: any = await executePrismaQuery(delegate(99) as any, options());

    expect(primeira.data.paginacao.totalPage).toBe(10);
    expect(segunda.data.paginacao.totalPage).toBe(99);
  });
});

import { beforeEach, describe, expect, test } from "bun:test";

import { executePrismaQuery } from "../src/functions/sql";
import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import { executeOrmQuery } from "../src/prisma8/query";
import {
  FakeCollection,
  fakeCombinators,
  fakeDb8,
  type FakeContractModels,
} from "../src/testing/prisma8Fakes";

beforeEach(() => {
  resetPrisma8();
  configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
});

describe("resumo no envelope: Prisma 7", () => {
  const delegate = () => {
    const aggregateCalls: any[] = [];
    return {
      aggregateCalls,
      fields: { id: { modelName: "Mensalidade", name: "id" } },
      findMany: async () => [{ id: "1" }, { id: "2" }],
      count: async () => 40,
      aggregate: async (args: any) => {
        aggregateCalls.push(args);
        return { _count: { _all: 40 }, _sum: { valor: 1234.5, desconto: null } };
      },
    };
  };

  test("summary soma e conta sobre o filtro inteiro, não sobre a página", async () => {
    const d = delegate();
    const result: any = await executePrismaQuery(
      d as any,
      {
        where: { status: "aberta" },
        page: 1,
        skip: 0,
        take: 2,
        summary: { sum: ["valor", "desconto"] },
      } as any,
    );

    expect(d.aggregateCalls).toEqual([
      {
        where: { status: "aberta" },
        _count: { _all: true },
        _sum: { valor: true, desconto: true },
      },
    ]);
    expect(result.data.resumo).toEqual({ count: 40, sum: { valor: 1234.5, desconto: null } });
    expect(result.data.data).toHaveLength(2);
  });

  test("sem summary, o envelope não ganha resumo nem consulta a mais", async () => {
    const d = delegate();
    const result: any = await executePrismaQuery(
      d as any,
      { where: {}, page: 1, skip: 0, take: 2 } as any,
    );
    expect(d.aggregateCalls).toEqual([]);
    expect(result.data.resumo).toBeUndefined();
  });

  test("a listagem vazia também traz o resumo", async () => {
    const d = { ...delegate(), findMany: async () => [] };
    const result: any = await executePrismaQuery(
      d as any,
      {
        where: {},
        page: 1,
        skip: 0,
        take: 2,
        summary: { sum: ["valor"] },
      } as any,
    );
    expect(result.data.resumo).toEqual({ count: 40, sum: { valor: 1234.5 } });
  });
});

describe("resumo no envelope: Prisma 8", () => {
  const models: FakeContractModels = { Mensalidade: { fields: ["id", "valor", "status"] } };

  test("aggregate com count e sum sobre o filtro inteiro", async () => {
    const col = new FakeCollection(models, "Mensalidade", {
      rows: [{ id: "1", valor: 10 }],
      count: 40,
      agregados: { valor: 777 },
    });

    const result: any = await executeOrmQuery(col, {
      where: { status: "aberta" },
      page: 1,
      skip: 0,
      take: 1,
      summary: { sum: ["valor"] },
    });

    const aggregate = col.calls.find(
      (call) => call.terminal === "aggregate" && (call.data as any)?.valor,
    );
    expect(aggregate?.data).toEqual({
      count: { fn: "count" },
      valor: { fn: "sum", field: "valor" },
    });
    expect(result.data.resumo).toEqual({ count: 40, sum: { valor: 777 } });
  });
});

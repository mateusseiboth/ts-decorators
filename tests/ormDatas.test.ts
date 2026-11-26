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

const models: FakeContractModels = { Aluno: { fields: ["id", "nome", "nascimento"] } };
const NASCIMENTO = new Date("2000-05-10T12:00:00.000Z");

beforeEach(() => {
  resetPrisma8();
  configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
});

const colecao = () =>
  new FakeCollection(models, "Aluno", {
    rows: [{ id: "1", nome: "Ana", nascimento: NASCIMENTO, codigo: 10n }],
    count: 1,
  });

describe("executeOrmQuery: tipos do domínio", () => {
  test("padrão: data sai como texto ISO", async () => {
    const result: any = await executeOrmQuery(colecao(), { page: 1, skip: 0, take: 10 });
    expect(result.data.data[0].nascimento).toBe("2000-05-10T12:00:00.000Z");
  });

  test("reviveDates mantém a data como Date (e o bigint continua texto)", async () => {
    const result: any = await executeOrmQuery(colecao(), {
      page: 1,
      skip: 0,
      take: 10,
      reviveDates: true,
    });
    expect(result.data.data[0].nascimento).toBeInstanceOf(Date);
    expect(result.data.data[0].nascimento.getTime()).toBe(NASCIMENTO.getTime());
    expect(result.data.data[0].codigo).toBe("10");
  });

  test("sem paginação, reviveDates vale igual", async () => {
    const result: any = await executeOrmQuery(colecao(), { reviveDates: true });
    expect(result.data.data[0].nascimento).toBeInstanceOf(Date);
  });

  test("mapRow monta o tipo do domínio a partir da linha", async () => {
    const result: any = await executeOrmQuery(colecao(), {
      page: 1,
      skip: 0,
      take: 10,
      reviveDates: true,
      mapRow: (row: any) => ({ id: row.id, idade: 2026 - row.nascimento.getUTCFullYear() }),
    });
    expect(result.data.data).toEqual([{ id: "1", idade: 26 }]);
  });
});

describe("executePrismaQuery: reviveDates", () => {
  test("mantém Date na linha do Prisma 7", async () => {
    const delegate = {
      fields: { id: { modelName: "Aluno", name: "id" } },
      findMany: async () => [{ id: "1", nascimento: NASCIMENTO }],
      count: async () => 1,
    };
    const result: any = await executePrismaQuery(
      delegate as any,
      {
        where: {},
        page: 1,
        skip: 0,
        take: 10,
        reviveDates: true,
      } as any,
    );
    expect(result.data.data[0].nascimento).toBeInstanceOf(Date);
  });
});

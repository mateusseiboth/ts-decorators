import { beforeEach, describe, expect, test } from "bun:test";

import { setDeriveTotalDefault } from "../src/functions/sql";
import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import { applyOrderBy } from "../src/prisma8/orderBy";
import { applyProjection } from "../src/prisma8/projection";
import { applyQueryOptions, executeOrmQuery } from "../src/prisma8/query";
import {
  fakeAst,
  FakeCollection,
  fakeCombinators,
  fakeDb8,
  type FakeContractModels,
} from "../src/testing/prisma8Fakes";

const models: FakeContractModels = {
  Bairro: {
    fields: ["id", "name", "entidade", "enabled", "sequencial"],
    relations: { setor: "Setores", rua: "Rua" },
  },
  Setores: { fields: ["id", "name"], relations: { distrito: "Distrito" } },
  Distrito: { fields: ["id", "name"] },
  Rua: { fields: ["id", "name", "bairro_id", "enabled"] },
};

/**
 * O codec `bool` do Postgres no Prisma 8 declara os traits `equality` e `boolean`, mas NÃO
 * `order` — então o acessor de uma coluna Boolean nasce sem `asc`/`desc`. Este model reproduz
 * isso: `active` é coluna de verdade, e mesmo assim não dá para pedir `.asc()` nela.
 */
const modelsComBooleano: FakeContractModels = {
  Produto: { fields: ["id", "nome"], semOrdenacao: ["active"] },
};

beforeEach(() => {
  resetPrisma8();
  configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
  setDeriveTotalDefault(false);
});

describe("applyOrderBy", () => {
  test("objeto e lista viram lambdas asc/desc na ordem", () => {
    const col = new FakeCollection(models, "Bairro");
    expect(applyOrderBy(col, { name: "asc" }).state.orderBy).toEqual([
      { order: "asc", field: "name" },
    ]);
    expect(applyOrderBy(col, [{ sequencial: "desc" }, { name: "asc" }]).state.orderBy).toEqual([
      { order: "desc", field: "sequencial" },
      { order: "asc", field: "name" },
    ]);
  });

  test("forma { sort } do Prisma 7 é aceita", () => {
    const col = new FakeCollection(models, "Bairro");
    expect(applyOrderBy(col, { name: { sort: "desc" } }).state.orderBy).toEqual([
      { order: "desc", field: "name" },
    ]);
  });

  test("relação to-one ordena pela subconsulta correlacionada da coluna dela", () => {
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators, ast: fakeAst });
    const col = new FakeCollection(models, "Bairro");

    expect(applyOrderBy(col, { setor: { name: "asc" } }).state.orderBy).toEqual([
      {
        order: "asc",
        field: { subquery: { rel: "setor", projection: [{ alias: "_ordem", expr: "name" }] } },
      },
    ]);
  });

  test("caminho de duas relações vira subconsulta dentro de subconsulta", () => {
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators, ast: fakeAst });
    const col = new FakeCollection(models, "Bairro");

    expect(applyOrderBy(col, { setor: { distrito: { name: "desc" } } }).state.orderBy).toEqual([
      {
        order: "desc",
        field: {
          subquery: {
            rel: "setor",
            projection: [
              {
                alias: "_ordem",
                expr: {
                  subquery: { rel: "distrito", projection: [{ alias: "_ordem", expr: "name" }] },
                },
              },
            ],
          },
        },
      },
    ]);
  });

  test("relação sem as classes do AST registradas falha alto, dizendo o que falta", () => {
    const col = new FakeCollection(models, "Bairro");
    expect(() => applyOrderBy(col, { setor: { name: "asc" } })).toThrow(/ast/);
  });

  test("campo que não existe na relação falha alto com o nome dele", () => {
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators, ast: fakeAst });
    const col = new FakeCollection(models, "Bairro");
    expect(() => applyOrderBy(col, { setor: { inventado: "asc" } })).toThrow(/inventado/);
  });

  test("coluna Boolean, que o ORM não sabe ordenar, ordena mesmo assim", () => {
    const col = new FakeCollection(modelsComBooleano, "Produto");

    expect(applyOrderBy(col, { active: "asc" }).state.orderBy).toEqual([
      { order: "asc", field: "active" },
    ]);
    expect(applyOrderBy(col, [{ active: "desc" }, { nome: "asc" }]).state.orderBy).toEqual([
      { order: "desc", field: "active" },
      { order: "asc", field: "nome" },
    ]);
  });

  test("campo que não existe continua falhando alto, mesmo com o resgate do Boolean", () => {
    const col = new FakeCollection(modelsComBooleano, "Produto");

    expect(() => applyOrderBy(col, { inventado: "asc" })).toThrow(/inventado/);
  });

  test("sem orderBy devolve a coleção intacta", () => {
    const col = new FakeCollection(models, "Bairro");
    expect(applyOrderBy(col, undefined)).toBe(col);
    expect(applyOrderBy(col, [])).toBe(col);
  });
});

describe("applyProjection — select/include do Prisma 7", () => {
  test("select só de escalares vira .select(...)", () => {
    const col = new FakeCollection(models, "Bairro");
    const out = applyProjection(col, { select: { id: true, name: true, entidade: false } });
    expect(out.state.select).toEqual(["id", "name"]);
    expect(out.state.include).toEqual([]);
  });

  test("select com relação true vira include sem refinamento", () => {
    const col = new FakeCollection(models, "Bairro");
    const out = applyProjection(col, { select: { id: true, setor: true } });
    expect(out.state.select).toEqual(["id"]);
    expect(out.state.include).toEqual([{ rel: "setor", branch: { where: [], include: [] } }]);
  });

  test("select aninhado com select/where/orderBy/take vira include refinado", () => {
    const col = new FakeCollection(models, "Bairro");
    const out = applyProjection(col, {
      include: {
        rua: {
          where: { enabled: true },
          orderBy: { name: "asc" },
          take: 5,
          select: { id: true, name: true },
        },
        setor: { select: { name: true, distrito: { select: { name: true } } } },
      },
    });
    expect(out.state.include).toEqual([
      {
        rel: "rua",
        branch: {
          where: [{ op: "eq", field: "enabled", value: true }],
          select: ["id", "name"],
          orderBy: [{ order: "asc", field: "name" }],
          limit: 5,
          include: [],
        },
      },
      {
        rel: "setor",
        branch: {
          where: [],
          select: ["name"],
          include: [{ rel: "distrito", branch: { where: [], select: ["name"], include: [] } }],
        },
      },
    ]);
  });

  test("distinct vira distinctOn com orderBy e distinct() sem; _count falha alto", () => {
    const col = new FakeCollection(models, "Bairro");
    expect(
      applyProjection(col, { distinct: ["entidade"], orderBy: { entidade: "asc" } } as never).state
        .distinctOn,
    ).toEqual(["entidade"]);
    expect(applyProjection(col, { distinct: "name" }).state.distinct).toBe(true);
    expect(applyProjection(col, { distinct: "name" }).state.distinctOn).toBeUndefined();
    expect(() => applyProjection(col, { include: { _count: true } })).toThrow(/_count/);
  });
});

describe("applyQueryOptions — where + orderBy + projeção + paginação", () => {
  test("monta a cadeia completa", () => {
    const col = new FakeCollection(models, "Bairro");
    const out = applyQueryOptions(col, {
      where: { enabled: true },
      orderBy: { name: "asc" },
      select: { id: true },
      skip: 20,
      take: 10,
    });
    expect(out.state).toEqual({
      where: [{ op: "eq", field: "enabled", value: true }],
      orderBy: [{ order: "asc", field: "name" }],
      select: ["id"],
      include: [],
      offset: 20,
      limit: 10,
    });
  });
});

describe("executeOrmQuery — mesma resposta paginada do executePrismaQuery", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1) }));

  test("busca os ids, depois as linhas por id e a contagem; devolve o shape histórico", async () => {
    const col = new FakeCollection(models, "Bairro", {
      rows: (state, call) =>
        call === 1 ? ids(3) : ids(3).map((r) => ({ ...r, name: "b" + r.id, sequencial: 10n })),
      count: 42,
    });
    const result: any = await executeOrmQuery(col, {
      where: { enabled: true },
      orderBy: { name: "asc" },
      include: { setor: true },
      page: 2,
      skip: 10,
      take: 10,
    });

    const [idsCall, rowsCall, countCall] = col.calls;
    expect(idsCall).toEqual({
      terminal: "all",
      state: {
        where: [{ op: "eq", field: "enabled", value: true }],
        orderBy: [{ order: "asc", field: "name" }],
        select: ["id"],
        include: [],
        offset: 10,
        limit: 10,
      },
    });
    expect(rowsCall?.state.where).toEqual([{ op: "in", field: "id", value: ["1", "2", "3"] }]);
    expect(rowsCall?.state.include).toEqual([{ rel: "setor", branch: { where: [], include: [] } }]);
    expect(rowsCall?.state.limit).toBeUndefined();
    expect(countCall?.terminal).toBe("aggregate");
    expect(countCall?.state.where).toEqual([{ op: "eq", field: "enabled", value: true }]);

    expect(result.data.data).toEqual([
      { id: "1", name: "b1", sequencial: "10" },
      { id: "2", name: "b2", sequencial: "10" },
      { id: "3", name: "b3", sequencial: "10" },
    ]);
    expect(result.data.paginacao).toEqual({ totalPage: 42, page: 2, total: 5 });
  });

  test("sem paginação (take ausente) é UMA consulta, sem `id in (...)`", async () => {
    // Listagem sem cabeçalho de paginação traz a tabela inteira. Buscar os ids e depois
    // `id in (227 mil)` faz o compilador da consulta parar de responder; sem `take` não há o
    // que paginar, então a projeção vai direto na consulta e a contagem é o próprio tamanho.
    const col = new FakeCollection(models, "Bairro", {
      rows: ids(3).map((r) => ({ ...r, name: "b" + r.id, sequencial: 10n })),
      count: 999,
    });
    const result: any = await executeOrmQuery(col, {
      where: { enabled: true },
      orderBy: { name: "asc" },
      include: { setor: true },
    });

    expect(col.calls.map((c) => c.terminal)).toEqual(["all"]);
    expect(col.calls[0]?.state).toEqual({
      where: [{ op: "eq", field: "enabled", value: true }],
      orderBy: [{ order: "asc", field: "name" }],
      include: [{ rel: "setor", branch: { where: [], include: [] } }],
    });
    expect(result.data.data).toEqual([
      { id: "1", name: "b1", sequencial: "10" },
      { id: "2", name: "b2", sequencial: "10" },
      { id: "3", name: "b3", sequencial: "10" },
    ]);
    expect(result.data.paginacao).toEqual({ totalPage: 3, page: undefined, total: 1 });
  });

  test("sem paginação e sem linhas devolve o shape vazio", async () => {
    const col = new FakeCollection(models, "Bairro", { rows: [] });
    const result: any = await executeOrmQuery(col, { where: { enabled: true } });
    expect(result).toEqual({ data: [], paginate: { totalPage: 0, page: 1, total: 0 } });
    expect(col.calls.map((c) => c.terminal)).toEqual(["all"]);
  });

  test("sem linhas devolve o shape vazio, sem contar", async () => {
    const col = new FakeCollection(models, "Bairro", { rows: [] });
    const result: any = await executeOrmQuery(col, {
      where: { enabled: true },
      take: 10,
      skip: 0,
      page: 1,
    });
    expect(result).toEqual({ data: [], paginate: { totalPage: 0, page: 1, total: 0 } });
    expect(col.calls.map((c) => c.terminal)).toEqual(["all"]);
  });

  test("deriveTotal deduz o total da página incompleta e não conta", async () => {
    const col = new FakeCollection(models, "Bairro", { rows: ids(3), count: 999 });
    const result: any = await executeOrmQuery(col, {
      skip: 10,
      take: 10,
      page: 2,
      deriveTotal: true,
    });
    expect(result.data.paginacao.totalPage).toBe(13);
    expect(col.calls.map((c) => c.terminal)).toEqual(["all", "all"]);
  });

  test("projeção do getColumns estreita o select do chamador", async () => {
    const col = new FakeCollection(models, "Bairro", { rows: ids(1), count: 1 });
    await executeOrmQuery(col, {
      select: { id: true, name: true, entidade: true },
      columns: { id: true, name: true, sequencial: true },
      take: 10,
      skip: 0,
    });
    expect(col.calls[1]?.state.select).toEqual(["id", "name"]);
  });
});

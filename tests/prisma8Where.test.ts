import { beforeEach, describe, expect, test } from "bun:test";

import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import { applyWhere, buildPredicate } from "../src/prisma8/where";
import {
  FakeCollection,
  fakeCombinators,
  fakeDb8,
  fakeProxy,
  type FakeContractModels,
} from "../src/testing/prisma8Fakes";

const models: FakeContractModels = {
  Bairro: {
    fields: ["id", "name", "entidade", "enabled", "createdAt", "setor_id"],
    relations: { setor: "Setores", rua: "Rua" },
  },
  Setores: { fields: ["id", "name", "distrito_id"], relations: { distrito: "Distrito" } },
  Distrito: { fields: ["id", "name"] },
  Rua: { fields: ["id", "name", "bairro_id"] },
};

const proxy = () => fakeProxy(models, "Bairro");

describe("buildPredicate — where do Prisma 7 vira predicado do Prisma 8", () => {
  beforeEach(() => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
  });

  test("igualdade por valor escalar", () => {
    expect(buildPredicate(proxy(), { name: "Centro" })).toEqual({
      op: "eq",
      field: "name",
      value: "Centro",
    });
  });

  test("null vira isNull", () => {
    expect(buildPredicate(proxy(), { setor_id: null })).toEqual({
      op: "isNull",
      field: "setor_id",
    });
  });

  test("dois campos viram and()", () => {
    expect(buildPredicate(proxy(), { enabled: true, entidade: 79 })).toEqual({
      op: "and",
      args: [
        { op: "eq", field: "enabled", value: true },
        { op: "eq", field: "entidade", value: 79 },
      ],
    });
  });

  test("where vazio não gera predicado", () => {
    expect(buildPredicate(proxy(), {})).toBeUndefined();
    expect(buildPredicate(proxy(), undefined)).toBeUndefined();
  });

  test("operadores de comparação", () => {
    expect(buildPredicate(proxy(), { entidade: { gt: 1, lte: 5 } })).toEqual({
      op: "and",
      args: [
        { op: "gt", field: "entidade", value: 1 },
        { op: "lte", field: "entidade", value: 5 },
      ],
    });
    expect(buildPredicate(proxy(), { id: { in: ["a", "b"] } })).toEqual({
      op: "in",
      field: "id",
      value: ["a", "b"],
    });
    expect(buildPredicate(proxy(), { id: { notIn: ["a"] } })).toEqual({
      op: "notIn",
      field: "id",
      value: ["a"],
    });
    expect(buildPredicate(proxy(), { name: { equals: "x" } })).toEqual({
      op: "eq",
      field: "name",
      value: "x",
    });
    expect(buildPredicate(proxy(), { name: { equals: null } })).toEqual({
      op: "isNull",
      field: "name",
    });
  });

  test("not: escalar vira neq, null vira isNotNull, objeto vira not(and(...))", () => {
    expect(buildPredicate(proxy(), { name: { not: "x" } })).toEqual({
      op: "neq",
      field: "name",
      value: "x",
    });
    expect(buildPredicate(proxy(), { name: { not: null } })).toEqual({
      op: "isNotNull",
      field: "name",
    });
    expect(buildPredicate(proxy(), { name: { not: { contains: "x" } } })).toEqual({
      op: "not",
      arg: { op: "like", field: "name", value: "%x%" },
    });
  });

  test("contains/startsWith/endsWith com mode insensitive viram ilike, sem mode viram like", () => {
    expect(buildPredicate(proxy(), { name: { contains: "cen", mode: "insensitive" } })).toEqual({
      op: "ilike",
      field: "name",
      value: "%cen%",
    });
    expect(buildPredicate(proxy(), { name: { startsWith: "Ce" } })).toEqual({
      op: "like",
      field: "name",
      value: "Ce%",
    });
    expect(buildPredicate(proxy(), { name: { endsWith: "ro", mode: "insensitive" } })).toEqual({
      op: "ilike",
      field: "name",
      value: "%ro",
    });
  });

  test("coluna sem LIKE (uuid) vira igualdade em contains/startsWith/endsWith, em vez de estourar", () => {
    // `?bairroId=contains:<uuid>` vinha das telas desde o tempo do Prisma 7, quando o id era
    // texto. O proxy de uma coluna uuid não tem `like`/`ilike`, e o filtro morria com
    // "undefined is not an object (evaluating 'field.ilike.bind')" (500).
    const semLike = () => {
      const p = proxy();
      const id = p.id as Record<string, unknown>;
      p.id = { ...id, like: undefined, ilike: undefined } as never;
      return p;
    };
    const uuid = "01a0d481-0afd-73bb-915b-5d442132fbf4";
    expect(buildPredicate(semLike(), { id: { contains: uuid, mode: "insensitive" } })).toEqual({
      op: "eq",
      field: "id",
      value: uuid,
    });
    expect(buildPredicate(semLike(), { id: { startsWith: uuid } })).toEqual({
      op: "eq",
      field: "id",
      value: uuid,
    });
    expect(buildPredicate(semLike(), { NOT: { id: { endsWith: uuid } } })).toEqual({
      op: "not",
      arg: { op: "eq", field: "id", value: uuid },
    });
  });

  test("curinga do LIKE no valor é escapado (o termo é literal, como no Prisma 7)", () => {
    expect(buildPredicate(proxy(), { name: { contains: "50%_a\\b" } })).toEqual({
      op: "like",
      field: "name",
      value: "%50\\%\\_a\\\\b%",
    });
  });

  test("AND/OR/NOT aninham com os combinadores", () => {
    const where = {
      AND: [{ enabled: true }, { OR: [{ name: "a" }, { name: "b" }] }],
      NOT: { entidade: 1 },
    };
    expect(buildPredicate(proxy(), where)).toEqual({
      op: "and",
      args: [
        { op: "eq", field: "enabled", value: true },
        {
          op: "or",
          args: [
            { op: "eq", field: "name", value: "a" },
            { op: "eq", field: "name", value: "b" },
          ],
        },
        { op: "not", arg: { op: "eq", field: "entidade", value: 1 } },
      ],
    });
  });

  test("AND com objeto único e NOT com lista", () => {
    expect(buildPredicate(proxy(), { AND: { name: "a" } })).toEqual({
      op: "eq",
      field: "name",
      value: "a",
    });
    expect(buildPredicate(proxy(), { NOT: [{ name: "a" }, { name: "b" }] })).toEqual({
      op: "not",
      arg: {
        op: "and",
        args: [
          { op: "eq", field: "name", value: "a" },
          { op: "eq", field: "name", value: "b" },
        ],
      },
    });
  });

  test("relação com objeto plano vira some(); some/every/none/is/isNot explícitos", () => {
    expect(buildPredicate(proxy(), { setor: { name: "Sul" } })).toEqual({
      op: "some",
      rel: "setor",
      pred: { op: "eq", field: "name", value: "Sul" },
    });
    expect(
      buildPredicate(proxy(), { rua: { some: { name: { contains: "x", mode: "insensitive" } } } }),
    ).toEqual({
      op: "some",
      rel: "rua",
      pred: { op: "ilike", field: "name", value: "%x%" },
    });
    expect(buildPredicate(proxy(), { rua: { none: {} } })).toEqual({
      op: "none",
      rel: "rua",
      pred: undefined,
    });
    expect(buildPredicate(proxy(), { rua: { every: { name: "a" } } })).toEqual({
      op: "every",
      rel: "rua",
      pred: { op: "eq", field: "name", value: "a" },
    });
    expect(buildPredicate(proxy(), { setor: { is: null } })).toEqual({
      op: "none",
      rel: "setor",
      pred: undefined,
    });
    expect(buildPredicate(proxy(), { setor: null })).toEqual({
      op: "none",
      rel: "setor",
      pred: undefined,
    });
    expect(buildPredicate(proxy(), { setor: { isNot: null } })).toEqual({
      op: "some",
      rel: "setor",
      pred: undefined,
    });
    expect(buildPredicate(proxy(), { setor: { isNot: { name: "a" } } })).toEqual({
      op: "not",
      arg: { op: "some", rel: "setor", pred: { op: "eq", field: "name", value: "a" } },
    });
  });

  test("relação aninhada em dois níveis", () => {
    expect(
      buildPredicate(proxy(), { setor: { distrito: { name: { contains: "Norte" } } } }),
    ).toEqual({
      op: "some",
      rel: "setor",
      pred: { op: "some", rel: "distrito", pred: { op: "like", field: "name", value: "%Norte%" } },
    });
  });

  test("campo desconhecido e operador sem equivalente falham alto", () => {
    expect(() => buildPredicate(proxy(), { inexistente: 1 })).toThrow(/inexistente/);
    expect(() => buildPredicate(proxy(), { name: { search: "x" } })).toThrow(/search/);
  });

  test("sem combinadores configurados, AND explica o que falta", () => {
    resetPrisma8();
    expect(() => buildPredicate(proxy(), { AND: [{ name: "a" }, { name: "b" }] })).toThrow(
      /configurePrisma8/,
    );
  });
});

describe("applyWhere — encadeia na coleção", () => {
  beforeEach(() => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
  });

  test("where com conteúdo vira um .where(lambda); vazio devolve a coleção intacta", () => {
    const col = new FakeCollection(models, "Bairro");
    const filtered = applyWhere(col, { name: "Centro" });
    expect(filtered.state.where).toEqual([{ op: "eq", field: "name", value: "Centro" }]);
    expect(applyWhere(col, {})).toBe(col);
    expect(applyWhere(col, undefined)).toBe(col);
  });
});

describe("equals com mode insensitive", () => {
  beforeEach(() => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
  });

  // No Prisma 7 `{ equals, mode: "insensitive" }` compara sem caixa. Traduzir para `eq` deixava o
  // login por e-mail sensível a maiúsculas sem erro nenhum: `Fulano@x.com` não achava `fulano@x.com`.
  test("vira ilike do termo inteiro, escapado", () => {
    expect(buildPredicate(proxy(), { name: { equals: "Jo%ão_1", mode: "insensitive" } })).toEqual({
      op: "ilike",
      field: "name",
      value: "Jo\\%ão\\_1",
    });
  });

  test("sem mode continua igualdade exata", () => {
    expect(buildPredicate(proxy(), { name: { equals: "Jo%ão" } })).toEqual({
      op: "eq",
      field: "name",
      value: "Jo%ão",
    });
  });

  test("dentro de not também ignora a caixa", () => {
    expect(
      buildPredicate(proxy(), { name: { not: { equals: "a_b", mode: "insensitive" } } }),
    ).toEqual({ op: "not", arg: { op: "ilike", field: "name", value: "a\\_b" } });
  });

  test("escapeLike é exportado para quem monta o ilike nativo", async () => {
    const { escapeLike } = await import("../index");
    expect(escapeLike("100%_\\")).toBe("100\\%\\_\\\\");
  });
});

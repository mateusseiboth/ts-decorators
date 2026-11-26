import { beforeEach, describe, expect, test } from "bun:test";

import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import { EMPTY_SQL, joinSql, sql, toTemplate } from "../src/prisma8/sqlFragment";
import { fakeCombinators, fakeDb8 } from "../src/testing/prisma8Fakes";

/**
 * Trechos de SQL cru com os parâmetros deles: o `Prisma.sql`/`Prisma.join`/`Prisma.empty` do
 * Prisma 7. O `db.raw.sql` do Prisma 8 só interpola VALOR; o trecho interpolado vira texto do
 * comando, e os valores dele, parâmetros na mesma ordem.
 */

/** O `param` do Prisma 8 (`@prisma/orm-family-sql/relational-core`), pela forma. */
const fakeParam = (value: unknown, options: { codecId: string }) => ({ param: value, ...options });

const renderSql = (fragmento: Parameters<typeof toTemplate>[0]) => {
  const [strings, ...values] = toTemplate(fragmento);
  return { sql: strings.raw.join("?"), values };
};

beforeEach(() => {
  resetPrisma8();
  configurePrisma8({ db: fakeDb8(), ...fakeCombinators, param: fakeParam });
});

describe("sql", () => {
  test("o valor interpolado vira parâmetro", () => {
    expect(renderSql(sql`entidade = ${10} AND nome = ${"Natal"}`)).toEqual({
      sql: "entidade = ? AND nome = ?",
      values: [10, "Natal"],
    });
  });

  test("o trecho interpolado vira texto do comando, com os valores dele na ordem", () => {
    const nomes = joinSql([sql`name = ${"Natal"}`, sql`name = ${"Páscoa"}`], " OR ");
    const filtro = sql`entidade = ${10} AND (${nomes})${EMPTY_SQL} AND id <> ${"x"}`;

    expect(renderSql(filtro)).toEqual({
      sql: "entidade = ? AND (name = ? OR name = ?) AND id <> ?",
      values: [10, "Natal", "Páscoa", "x"],
    });
  });

  test("trecho sem valor entra como texto puro", () => {
    expect(renderSql(sql`SELECT 1 ${sql`WHERE true`}`)).toEqual({
      sql: "SELECT 1 WHERE true",
      values: [],
    });
  });
});

describe("joinSql", () => {
  test("sem trechos, nada", () => {
    expect(renderSql(joinSql([], ", "))).toEqual({ sql: "", values: [] });
  });

  test("o separador é texto, nunca parâmetro", () => {
    expect(renderSql(joinSql([sql`${1}`, sql`${2}`, sql`${3}`], ", "))).toEqual({
      sql: "?, ?, ?",
      values: [1, 2, 3],
    });
  });
});

describe("toTemplate", () => {
  test("a data vai como parâmetro timestamptz, pelo param registrado", () => {
    const desde = new Date("2026-01-01T03:00:00.000Z");

    expect(renderSql(sql`date >= ${desde} AND ${sql`date < ${desde}`}`)).toEqual({
      sql: "date >= ? AND date < ?",
      values: [
        { param: desde, codecId: "pg/timestamptz-date@1" },
        { param: desde, codecId: "pg/timestamptz-date@1" },
      ],
    });
  });

  test("data sem o param registrado falha alto", () => {
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });

    expect(() => toTemplate(sql`date >= ${new Date()}`)).toThrow(/param/);
  });

  test("sem data, não precisa do param", () => {
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });

    expect(renderSql(sql`id = ${"x"}`)).toEqual({ sql: "id = ?", values: ["x"] });
  });

  test("o resultado é o que o db.raw.sql recebe", () => {
    const plano = fakeDb8()
      .raw.sql(...toTemplate(sql`DELETE FROM feriados WHERE id = ${"x"}`))
      .affectedCount()
      .build();

    expect(plano).toEqual({
      sql: "DELETE FROM feriados WHERE id = ?",
      values: ["x"],
      kind: "execute",
    });
  });
});

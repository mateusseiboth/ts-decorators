import { beforeEach, describe, expect, test } from "bun:test";

import { fakeCombinators, fakeDb8 } from "../testing/prisma8Fakes";
import { configurePrisma8, resetPrisma8 } from "./client";
import { EMPTY_SQL, joinSql, sql, sqlNullable, toTemplate } from "./sqlFragment";

/**
 * Este teste mora no `src` para o `tsc` conferir o TIPO: o `raw.sql` do Prisma 8 aceita
 * `RawSqlInterpolation` (o literal cru `number | bigint | string | boolean | Uint8Array`, ou um
 * `ParamRef`). A tag abaixo tem a mesma assinatura do lado do literal; passar o `toTemplate` a ela
 * sem cast é o que o projeto faz com o `db.raw.sql`.
 */
type RawSqlLiteral = number | bigint | string | boolean | Uint8Array;
type RawSqlTag = (
  strings: TemplateStringsArray,
  ...values: RawSqlLiteral[]
) => { sql: string; values: RawSqlLiteral[] };

const rawSql: RawSqlTag = (strings, ...values) => ({ sql: strings.raw.join("?"), values });

beforeEach(() => {
  resetPrisma8();
  configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
});

describe("toTemplate no tipo do raw.sql do Prisma 8", () => {
  test("condições opcionais com joinSql e EMPTY_SQL passam sem cast", () => {
    const nome: string | undefined = "Ana";
    const academia = "a-1";
    const ativo: boolean | undefined = undefined;
    const condicoes = [
      sql`academia_id = ${academia}`,
      nome ? sql`nome ILIKE ${`%${nome}%`}` : EMPTY_SQL,
      ativo === undefined ? EMPTY_SQL : sql`ativo = ${ativo}`,
    ].filter((condicao) => condicao !== EMPTY_SQL);

    const plano = rawSql(
      ...toTemplate(sql`SELECT id FROM aluno WHERE ${joinSql(condicoes, " AND ")}`),
    );

    expect(plano).toEqual({
      sql: "SELECT id FROM aluno WHERE academia_id = ? AND nome ILIKE ?",
      values: ["a-1", "%Ana%"],
    });
  });

  test("null interpolado sai como NULL no texto, nunca como parâmetro", () => {
    const telefone: string | null = null;
    expect(rawSql(...toTemplate(sql`UPDATE aluno SET telefone = ${telefone}`))).toEqual({
      sql: "UPDATE aluno SET telefone = NULL",
      values: [],
    });
  });

  test("sqlNullable: NULL tipado quando falta, o valor com o mesmo tipo quando existe", () => {
    expect(rawSql(...toTemplate(sql`SELECT ${sqlNullable(null, "uuid")}`))).toEqual({
      sql: "SELECT CAST(NULL AS uuid)",
      values: [],
    });
    expect(rawSql(...toTemplate(sql`SELECT ${sqlNullable("x-1", "uuid")}`))).toEqual({
      sql: "SELECT CAST(? AS uuid)",
      values: ["x-1"],
    });
  });

  test("sqlNullable recusa tipo que não é nome de tipo", () => {
    expect(() => sqlNullable(null, "uuid); DROP TABLE aluno; --")).toThrow("tipo");
  });

  test("undefined interpolado é erro do chamador, não parâmetro", () => {
    const sumido: string | undefined = undefined;
    expect(() => sql`nome = ${sumido}`).toThrow("undefined");
  });
});

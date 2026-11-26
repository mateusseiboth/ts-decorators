import { beforeEach, describe, expect, test } from "bun:test";

import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import { applyOrderBy } from "../src/prisma8/orderBy";
import { applyWhere } from "../src/prisma8/where";
import {
  fakeAst,
  FakeCollection,
  fakeCombinators,
  fakeDb8,
  type FakeContractModels,
} from "../src/testing/prisma8Fakes";

/**
 * A RELAÇÃO é da variante: a lista é da base `Titulo` (discriminada), e `fornecedor` (com a chave
 * `fornecedorId`) é da variante `TituloAPagar`, na mesma tabela. O ORM não enxerga a relação na
 * base; o pacote monta a subconsulta correlacionada pela coluna da chave.
 */
const models: FakeContractModels = {
  Titulo: {
    fields: ["id", "tipo", "valor"],
    variants: { PAGAR: "TituloAPagar", RECEBER: "TituloAReceber" },
    table: "titulo",
  },
  TituloAPagar: {
    fields: ["fornecedorId", "favorecidoNome"],
    base: "Titulo",
    relations: { fornecedor: "Fornecedor" },
  },
  TituloAReceber: { fields: ["pagadorNome"], base: "Titulo" },
  Fornecedor: { fields: ["id", "nome"], table: "fornecedor" },
};

const ORIGEM = ' FROM "public"."fornecedor" AS "_rel_fornecedor" WHERE ? = ?';

beforeEach(() => {
  resetPrisma8();
  configurePrisma8({ db: fakeDb8(), ...fakeCombinators, ast: fakeAst as any });
});

const titulos = () => new FakeCollection(models, "Titulo");

describe("ordenar pela relação de uma variante, na coleção da base", () => {
  test("fornecedor.nome crescente: subconsulta correlacionada pela chave da variante", () => {
    const ordenada = applyOrderBy(titulos(), { fornecedor: { nome: "asc" } });
    expect(ordenada.state.orderBy).toEqual([
      {
        order: "asc",
        field: {
          sql: `(SELECT ?${ORIGEM})`,
          values: ["nome", "id", "fornecedorId"],
          returns: { codecId: "pg/text@1", nullable: true },
        },
      },
    ]);
  });

  test("fornecedor.nome decrescente", () => {
    const ordenada = applyOrderBy(titulos(), [{ fornecedor: { nome: "desc" } }]);
    const [item] = (ordenada.state.orderBy ?? []) as Array<{ order: string }>;
    expect(item?.order).toBe("desc");
  });

  test("campo de variante direto na base ordena pela coluna da tabela", () => {
    const ordenada = applyOrderBy(titulos(), { favorecidoNome: "asc" });
    expect(ordenada.state.orderBy).toEqual([{ order: "asc", field: "favorecidoNome" }]);
  });
});

describe("filtrar pela relação de uma variante, na coleção da base", () => {
  test("fornecedor.nome contains vira EXISTS com ILIKE na coluna do relacionado", () => {
    const filtrada = applyWhere(titulos(), {
      fornecedor: { nome: { contains: "x", mode: "insensitive" } },
    });
    expect(filtrada.state.where).toEqual([
      {
        sql: `EXISTS (SELECT 1${ORIGEM} AND (?))`,
        values: [
          "id",
          "fornecedorId",
          { sql: "? ILIKE ?", values: ["nome", "%x%"], returns: "pg/bool@1" },
        ],
        returns: "pg/bool@1",
      },
    ]);
  });

  test("fornecedor null é a chave nula", () => {
    const filtrada = applyWhere(titulos(), { fornecedor: null });
    expect(filtrada.state.where).toEqual([
      { sql: "? IS NULL", values: ["fornecedorId"], returns: "pg/bool@1" },
    ]);
  });

  test("isNot vira NOT EXISTS", () => {
    const filtrada = applyWhere(titulos(), { fornecedor: { isNot: { nome: "Acme" } } });
    const [where] = filtrada.state.where as Array<{ sql: string }>;
    expect(where?.sql.startsWith("NOT EXISTS (SELECT 1")).toBe(true);
  });

  test("campo da base continua pelo acessor do ORM", () => {
    const filtrada = applyWhere(titulos(), { tipo: "PAGAR" });
    expect(filtrada.state.where).toEqual([{ op: "eq", field: "tipo", value: "PAGAR" }]);
  });
});

import { beforeEach, describe, expect, test } from "bun:test";

import { ModelTagged } from "../src/decorators/getModel";
import { Field, InitFields } from "../src/decorators/initFields";
import { getOrderBy } from "../src/middlwares/getOrderBy";
import { getWhere } from "../src/middlwares/getWhere";
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
import { mockNext, mockReq, mockRes } from "./_helpers";

/**
 * Model discriminado do Prisma 8: a base `Vinculo` (com `tipo`) e a variante ALUNO, guardada na
 * MESMA tabela, com `nome` e `cpf`. A `Mensalidade` aponta para a base. O ORM não enxerga campo
 * de variante pela relação ("Model Vinculo has no field nome"): o pacote monta a coluna.
 */
const models: FakeContractModels = {
  Vinculo: { fields: ["id", "tipo", "academiaId"], variants: { ALUNO: "VinculoDeAluno" } },
  VinculoDeAluno: { fields: ["nome", "cpf"], base: "Vinculo" },
  Mensalidade: { fields: ["id", "valor", "alunoId"], relations: { aluno: "Vinculo" } },
};

beforeEach(() => {
  resetPrisma8();
  configurePrisma8({ db: fakeDb8(), ...fakeCombinators, ast: fakeAst as any });
});

const mensalidades = () => new FakeCollection(models, "Mensalidade");

describe("ordenar por campo de variante através da relação", () => {
  test("aluno.nome crescente vira a subconsulta da coluna da variante", () => {
    const ordenada = applyOrderBy(mensalidades(), { aluno: { nome: "asc" } });
    expect(ordenada.state.orderBy).toEqual([
      {
        order: "asc",
        field: { subquery: { rel: "aluno", projection: [{ alias: "_ordem", expr: "nome" }] } },
      },
    ]);
  });

  test("aluno.nome decrescente", () => {
    const ordenada = applyOrderBy(mensalidades(), [{ aluno: { nome: "desc" } }]);
    const [item] = (ordenada.state.orderBy ?? []) as Array<{ order: string }>;
    expect(item?.order).toBe("desc");
  });

  test("campo da base pela relação continua pelo acessor do ORM", () => {
    const ordenada = applyOrderBy(mensalidades(), { aluno: { tipo: "asc" } });
    expect(ordenada.state.orderBy).toEqual([
      {
        order: "asc",
        field: { subquery: { rel: "aluno", projection: [{ alias: "_ordem", expr: "tipo" }] } },
      },
    ]);
  });
});

describe("filtrar por campo de variante através da relação", () => {
  test("aluno.nome contains sem diferenciar maiúsculas vira ILIKE na coluna da variante", () => {
    const filtrada = applyWhere(mensalidades(), {
      aluno: { nome: { contains: "an", mode: "insensitive" } },
    });
    expect(filtrada.state.where).toEqual([
      {
        op: "some",
        rel: "aluno",
        pred: { sql: "? ILIKE ?", values: ["nome", "%an%"], returns: "pg/bool@1" },
      },
    ]);
  });

  test("igualdade, lista e nulo na coluna da variante", () => {
    const filtrada = applyWhere(mensalidades(), {
      aluno: { cpf: { in: ["1", "2"] }, nome: null },
    });
    const pred = (filtrada.state.where[0] as { pred: unknown }).pred;
    expect(pred).toEqual({
      op: "and",
      args: [
        { sql: "? IN (?, ?)", values: ["cpf", "1", "2"], returns: "pg/bool@1" },
        { sql: "? IS NULL", values: ["nome"], returns: "pg/bool@1" },
      ],
    });
  });

  test("campo da base pela relação continua pelo acessor do ORM", () => {
    const filtrada = applyWhere(mensalidades(), { aluno: { tipo: "ALUNO" } });
    expect(filtrada.state.where).toEqual([
      { op: "some", rel: "aluno", pred: { op: "eq", field: "tipo", value: "ALUNO" } },
    ]);
  });
});

describe("declaração no model do projeto", () => {
  @InitFields
  @ModelTagged
  class AlunoVarianteModel {
    static tag = 99501;
    @Field() id!: string;
    @Field() nome!: string;
    static getModel() {
      return new AlunoVarianteModel();
    }
  }

  @InitFields
  @ModelTagged
  class MensalidadeVarianteModel {
    static tag = 99502;
    @Field() id!: string;
    // A relação aponta para a base no contrato; no model do projeto, para a classe da variante.
    @Field(AlunoVarianteModel) aluno!: AlunoVarianteModel;
    static getModel() {
      return new MensalidadeVarianteModel();
    }
  }

  test("getOrderBy e getWhere produzem o caminho aluno.nome", () => {
    const resOrdem = mockRes();
    getOrderBy(
      mockReq({ query: { orderBy: "aluno.nome", orderMethod: "asc" } }),
      resOrdem,
      mockNext(),
      MensalidadeVarianteModel,
    );
    expect(resOrdem.locals.orderBy[0]).toEqual({ aluno: { nome: "asc" } });

    const resFiltro = mockRes();
    getWhere(
      mockReq({ query: { "aluno.nome": "contains:an" } }),
      resFiltro,
      mockNext(),
      MensalidadeVarianteModel,
    );
    expect(resFiltro.locals.where).toEqual({
      OR: [{ aluno: { nome: { contains: "an", mode: "insensitive" } } }],
    });
  });
});

import { afterEach, describe, expect, test } from "bun:test";

import { ModelTagged } from "../src/decorators/getModel";
import { Field, InitFields } from "../src/decorators/initFields";
import { configureDateFilter, getWhere } from "../src/middlwares/getWhere";
import { mockNext, mockReq, mockRes } from "./_helpers";

@InitFields
@ModelTagged
class AlunoModel {
  static tag = 99301;
  static search = { fields: ["nome", "cpf", "telefone"] };
  @Field("uuid") id!: string;
  @Field("uuid") academia_id!: string;
  @Field() nome!: string;
  @Field({ type: "string", normalize: "digits" }) cpf!: string;
  @Field() telefone!: string;
  @Field("date") nascimento!: Date;
  @Field("number") idade!: number;
  static getModel() {
    return new AlunoModel();
  }
}

@InitFields
@ModelTagged
class PlanoModel {
  static tag = 99302;
  static search = { param: "q", fields: ["nome"] };
  @Field() nome!: string;
  static getModel() {
    return new PlanoModel();
  }
}

const runWhere = (query: Record<string, string>, model: any = AlunoModel) => {
  const res = mockRes();
  const next = mockNext();
  getWhere(mockReq({ query }), res, next, model);
  return { res, next };
};

describe("getWhere: fuso do filtro de data", () => {
  afterEach(() => configureDateFilter({}));

  test("o dia vale no fuso informado pelo contexto", () => {
    configureDateFilter({ timeZone: () => "America/Cuiaba" });
    const { res } = runWhere({ nascimento: "2026-01-15" });
    expect(res.locals.where).toEqual({
      OR: [
        {
          nascimento: {
            gte: new Date("2026-01-15T04:00:00.000Z"),
            lte: new Date("2026-01-16T03:59:59.999Z"),
          },
        },
      ],
    });
  });

  test("data com hora é o instante no fuso informado", () => {
    configureDateFilter({ timeZone: () => "America/Sao_Paulo" });
    const { res } = runWhere({ nascimento: "greaterThan:2026-01-15 10:30" });
    expect(res.locals.where.OR[0].nascimento.gt).toEqual(new Date("2026-01-15T13:30:00.000Z"));
  });

  test("sem fuso no contexto, vale o fuso do processo", () => {
    configureDateFilter({ timeZone: () => undefined });
    const { res } = runWhere({ nascimento: "2026-01-15" });
    const inicio = new Date(2026, 0, 15, 0, 0, 0, 0);
    expect(res.locals.where.OR[0].nascimento.gte).toEqual(inicio);
  });

  test("fuso inválido é erro de configuração, não filtro errado", () => {
    configureDateFilter({ timeZone: () => "Marte/Olympus" });
    expect(() => runWhere({ nascimento: "2026-01-15" })).toThrow("Marte/Olympus");
  });
});

describe("getWhere: campo uuid", () => {
  test("uuid válido filtra por igualdade", () => {
    const id = "019ffadb-aa94-7138-888a-d4ceabd3c2c1";
    const { res, next } = runWhere({ academia_id: id });
    expect(next.called).toBe(true);
    expect(res.locals.where).toEqual({ OR: [{ academia_id: { equals: id } }] });
  });

  test("uuid inválido responde 400 no campo, em vez do erro do banco", () => {
    const { res, next } = runWhere({ academia_id: "123" });
    expect(next.called).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res._body.errors).toEqual([
      { path: "academia_id", message: 'Informe um identificador válido no filtro "academia_id".' },
    ]);
  });

  test("lista com um uuid inválido também responde 400", () => {
    const { res } = runWhere({ id: "in:019ffadb-aa94-7138-888a-d4ceabd3c2c1,x" });
    expect(res.statusCode).toBe(400);
    expect(res._body.errors[0].path).toBe("id");
  });

  test("contains em uuid vira igualdade (não existe trecho de uuid)", () => {
    const id = "019ffadb-aa94-7138-888a-d4ceabd3c2c1";
    const { res } = runWhere({ id: `contains:${id}` });
    expect(res.locals.where).toEqual({ OR: [{ id: { equals: id } }] });
  });
});

describe("getWhere: busca em várias colunas", () => {
  test("busca vira OU de contains sem diferenciar maiúsculas nas colunas declaradas", () => {
    const { res } = runWhere({ busca: "Maria" });
    expect(res.locals.where).toEqual({
      AND: [
        {
          OR: [
            { nome: { contains: "Maria", mode: "insensitive" } },
            { telefone: { contains: "Maria", mode: "insensitive" } },
          ],
        },
      ],
    });
  });

  test("a coluna normalizada recebe o termo normalizado (CPF com máscara acha sem máscara)", () => {
    const { res } = runWhere({ busca: "123.456" });
    expect(res.locals.where.AND[0].OR).toContainEqual({
      cpf: { contains: "123456", mode: "insensitive" },
    });
  });

  test("a busca soma com os outros filtros", () => {
    const { res } = runWhere({ busca: "ana", idade: "30" });
    expect(res.locals.where).toEqual({
      OR: [{ idade: { equals: 30 } }],
      AND: [
        {
          OR: [
            { nome: { contains: "ana", mode: "insensitive" } },
            { telefone: { contains: "ana", mode: "insensitive" } },
          ],
        },
      ],
    });
  });

  test("o parâmetro da busca é configurável", () => {
    const { res } = runWhere({ q: "Ouro", busca: "ignorado" }, PlanoModel);
    expect(res.locals.where).toEqual({
      AND: [{ OR: [{ nome: { contains: "Ouro", mode: "insensitive" } }] }],
    });
  });

  test("busca vazia não filtra", () => {
    const { res } = runWhere({ busca: "  " });
    expect(res.locals.where).toEqual({});
  });
});

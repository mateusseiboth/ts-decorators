import { afterEach, describe, expect, test } from "bun:test";

import { getModel, ModelTagged } from "../src/decorators/getModel";
import { Field, getFieldOptions, InitFields } from "../src/decorators/initFields";
import {
  configureEncryption,
  decryptValue,
  isEncryptedValue,
  resetEncryption,
} from "../src/fields/encryption";
import { normalizeValue } from "../src/fields/normalize";
import { createWhereConditionQuery, getWhere } from "../src/middlwares/getWhere";
import { encodeRowForCollection } from "../src/prisma8/temporal";
import { FakeCollection } from "../src/testing/prisma8Fakes";
import { fakeClassContext, fakeFieldContext, mockNext, mockReq, mockRes } from "./_helpers";

@InitFields
@ModelTagged
class PessoaNormalizadaModel {
  static tag = 9811;
  static prismaModel = "PessoaNormalizada";
  @Field({ type: "string", normalize: "digits" }) cpf!: string;
  @Field({ type: "string", normalize: ["trim", "upper"] }) nome!: string;
  @Field({ type: "string", normalize: (valor) => valor.toLowerCase() }) email!: string;
  @Field({ type: "string", normalize: "digits", encrypted: true }) conta!: string;
  @Field("string") livre!: string;
}

const colecao = () =>
  new FakeCollection(
    { PessoaNormalizada: { fields: ["cpf", "nome", "email", "conta", "livre"] } },
    "PessoaNormalizada",
  );

afterEach(() => resetEncryption());

describe("normalizeValue", () => {
  test("cada normalizador", () => {
    expect(normalizeValue("123.456.789-09", "digits")).toBe("12345678909");
    expect(normalizeValue("  Maria   da  Silva ", "trim")).toBe("Maria da Silva");
    expect(normalizeValue("maria", "upper")).toBe("MARIA");
    expect(normalizeValue(" a  b ", ["trim", "upper"])).toBe("A B");
    expect(normalizeValue("X", (valor) => `${valor}!`)).toBe("X!");
  });

  test("nulo, vazio e o que não é texto passam intactos", () => {
    expect(normalizeValue(null, "digits")).toBeNull();
    expect(normalizeValue(undefined, "digits")).toBeUndefined();
    expect(normalizeValue("", "digits")).toBe("");
    expect(normalizeValue(123, "upper")).toBe(123);
    expect(normalizeValue("sem regra", undefined)).toBe("sem regra");
  });
});

describe("@Field({ normalize })", () => {
  test("registra a opção e mantém o tipo", () => {
    expect(getFieldOptions(PessoaNormalizadaModel.prototype).cpf).toEqual({
      type: "string",
      normalize: "digits",
    });
  });

  test("a gravação normaliza; com encrypted, normaliza antes de cifrar", () => {
    configureEncryption({ keys: { k1: Buffer.alloc(32, 7).toString("base64") }, current: "k1" });
    const linha = encodeRowForCollection(colecao(), {
      cpf: "123.456.789-09",
      nome: "  joão  souza ",
      email: "A@B.COM",
      conta: "12.345-6",
      livre: "  como veio ",
    });

    expect(linha.cpf).toBe("12345678909");
    expect(linha.nome).toBe("JOÃO SOUZA");
    expect(linha.email).toBe("a@b.com");
    expect(linha.livre).toBe("  como veio ");
    expect(isEncryptedValue(linha.conta)).toBe(true);
    expect(decryptValue(linha.conta)).toBe("123456");
  });

  test("valor nulo passa intacto na gravação", () => {
    expect(encodeRowForCollection(colecao(), { cpf: null }).cpf).toBeNull();
  });
});

describe("filtro em campo normalizado", () => {
  const classBase = {
    getModel: () => getModel(PessoaNormalizadaModel.tag),
    tag: PessoaNormalizadaModel.tag,
  };

  test("getWhere normaliza o valor: CPF com máscara acha o gravado sem máscara", () => {
    const res = mockRes();
    getWhere(mockReq({ query: { cpf: "123.456.789-09" } }), res, mockNext(), classBase);
    expect(res.locals.where).toEqual({ OR: [{ cpf: { equals: "12345678909" } }] });
  });

  test("busca por trecho e lista também normalizam cada valor", () => {
    const opcoes = getFieldOptions(PessoaNormalizadaModel.prototype);
    const tipos = { cpf: "string", nome: "string" };
    expect(createWhereConditionQuery("contains:456.7", "cpf", tipos, new Set(), opcoes)).toEqual({
      OR: [{ cpf: { contains: "4567", mode: "insensitive" } }],
      NOT: [],
    });
    expect(createWhereConditionQuery("in: ana , bia", "nome", tipos, new Set(), opcoes)).toEqual({
      OR: [{ nome: { in: ["ANA", "BIA"] } }],
      NOT: [],
    });
  });
});

describe("@Field com opções no padrão TC39", () => {
  test("a opção vai para o metadata e o @InitFields a registra; a base não herda da subclasse", () => {
    (Symbol as any).metadata ??= Symbol("Symbol.metadata");
    const baseMeta: Record<string, any> = {};
    Field({ type: "string", normalize: "digits" })(undefined, fakeFieldContext("cpf", baseMeta));
    class BaseTc39 {}
    InitFields(BaseTc39, { ...fakeClassContext("BaseTc39"), metadata: baseMeta } as any);
    (BaseTc39 as any)[Symbol.metadata] = baseMeta;

    const filhaMeta: Record<string, any> = Object.create(baseMeta);
    Field({ encrypted: true })(undefined, fakeFieldContext("senha", filhaMeta));
    class FilhaTc39 extends BaseTc39 {}
    InitFields(FilhaTc39, { ...fakeClassContext("FilhaTc39"), metadata: filhaMeta } as any);
    (FilhaTc39 as any)[Symbol.metadata] = filhaMeta;

    expect(getFieldOptions(FilhaTc39.prototype)).toEqual({
      cpf: { type: "string", normalize: "digits" },
      senha: { encrypted: true },
    });
    expect(getFieldOptions(BaseTc39.prototype)).toEqual({
      cpf: { type: "string", normalize: "digits" },
    });
  });
});

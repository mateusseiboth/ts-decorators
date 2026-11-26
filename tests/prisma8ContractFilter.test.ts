import { describe, expect, test } from "bun:test";

import { assertWhereFitsContract, InvalidFilterError } from "../src/prisma8/contractFilter";
import { FakeCollection, type FakeContractModels } from "../src/testing/prisma8Fakes";

/**
 * O filtro conferido contra o contrato da coleção, no que o client do Prisma 7 recusava antes de
 * ir ao banco e o Prisma 8 executaria, devolvendo a página vazia: nulo em coluna obrigatória.
 */
const MODELS: FakeContractModels = {
  legislacao: { fields: ["id", "nome", "anexo", "enabled", "deleted"], required: ["id", "nome"] },
  profiles: { fields: ["id", "nome"], relations: { orgao: "orgao" }, required: ["id", "nome"] },
  orgao: { fields: ["id"] },
};

const legislacao = new FakeCollection(MODELS, "legislacao");

const failureOf = (fn: () => void): unknown => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};

describe("assertWhereFitsContract", () => {
  test("nulo em coluna obrigatória é recusado, em qualquer nível", () => {
    for (const where of [
      { nome: null },
      { nome: { equals: null } },
      { AND: [{ enabled: true }, { nome: null }] },
      { OR: [{ nome: "a" }, { nome: { equals: null } }] },
      { NOT: { nome: null } },
    ]) {
      const erro = failureOf(() => assertWhereFitsContract(legislacao, where));

      expect({ where, erro }).toEqual({ where, erro: expect.any(InvalidFilterError) });
    }
  });

  test("o erro diz o campo e o motivo, e responde 400", () => {
    const erro = failureOf(() => assertWhereFitsContract(legislacao, { nome: null }));

    expect(erro).toMatchObject({
      name: "InvalidFilterError",
      campo: "nome",
      motivo: "nulo em coluna obrigatória",
      statusCode: 400,
    });
  });

  test("passa o que o Prisma 7 aceitava: nulo em coluna opcional, valor, outros operadores", () => {
    for (const where of [
      undefined,
      {},
      { anexo: null },
      { anexo: { equals: null } },
      { nome: { contains: "a", mode: "insensitive" }, AND: [{ enabled: true }] },
      { nome: { not: null } },
      { deleted: false, enabled: true },
      { createdAt: new Date() },
    ]) {
      expect({ where, erro: failureOf(() => assertWhereFitsContract(legislacao, where)) }).toEqual({
        where,
        erro: null,
      });
    }
  });

  test("chave que não é coluna (relação) fica para o ORM", () => {
    const profiles = new FakeCollection(MODELS, "profiles");

    expect(failureOf(() => assertWhereFitsContract(profiles, { orgao: null }))).toBe(null);
  });

  test("contrato que não diz se a coluna aceita nulo não recusa nada", () => {
    const orgao = new FakeCollection(MODELS, "orgao");

    expect(failureOf(() => assertWhereFitsContract(orgao, { id: null }))).toBe(null);
  });
});

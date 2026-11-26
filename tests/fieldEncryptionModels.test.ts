import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Field, InitFields } from "../src/decorators/initFields";
import { EncryptionError, configureEncryption, resetEncryption } from "../src/fields/encryption";
import { checkEncryptedModels, findUnmappedModels } from "../src/fields/rowFields";
import { setPrismaClient } from "../src/handlers/prisma";
import { decodeRowsForCollection, encodeRowForCollection } from "../src/prisma8/temporal";

/**
 * Classe com campo cifrado cujo nome não casa com model nenhum do Prisma gravaria em texto puro
 * sem ninguém saber. Quando o pacote conhece todos os models (contrato do Prisma 8, client do
 * Prisma 7), o primeiro uso confere e falha alto.
 */

@InitFields
class CofreErradoModel {
  @Field({ type: "string", encrypted: true }) segredo!: string;
}

@InitFields
class CofreBaseModel {
  @Field({ type: "string", encrypted: true }) senhaBase!: string;
}

@InitFields
class CofreFilhoModel extends CofreBaseModel {
  static prismaModel = "cofre_filho";
}

void CofreErradoModel;
void CofreFilhoModel;

/** Os models que as classes cifradas registradas no processo procuram, menos os excluídos. */
const nomesMapeados = (...excluidos: string[]) =>
  findUnmappedModels(new Set())
    .map((item) => item.prismaModel)
    .filter((nome) => !excluidos.includes(nome));

/** Coleção com contrato COMPLETO (a do Prisma 8 real traz todos os models do schema). */
function colecaoReal(modelos: string[], modelName: string) {
  const models = Object.fromEntries(modelos.map((nome) => [nome, { fields: {} }]));
  return {
    contract: { domain: { namespaces: { public: { models } } } },
    modelName,
    namespaceId: "public",
  };
}

beforeEach(() =>
  configureEncryption({ keys: { k1: Buffer.alloc(32, 3).toString("base64") }, current: "k1" }),
);
afterEach(() => resetEncryption());

describe("Prisma 8: o contrato confere as classes cifradas no primeiro uso", () => {
  test("classe sem model no contrato: UNMAPPED_MODEL na gravação e na leitura", () => {
    const colecao = colecaoReal([...nomesMapeados("CofreErrado"), "Outro"], "Outro");

    const erro = (() => {
      try {
        encodeRowForCollection(colecao, { nome: "x" });
      } catch (e) {
        return e as EncryptionError;
      }
    })();
    expect(erro).toBeInstanceOf(EncryptionError);
    expect(erro!.code).toBe("UNMAPPED_MODEL");
    expect(erro!.message).toContain("CofreErradoModel");
    expect(erro!.message).toContain('"CofreErrado"');
    expect(erro!.message).toContain("static prismaModel");
    expect(() => decodeRowsForCollection(colecao, [{ nome: "x" }])).toThrow(EncryptionError);
  });

  test("com todos os models no contrato, passa", () => {
    const colecao = colecaoReal([...nomesMapeados(), "Outro"], "Outro");
    expect(encodeRowForCollection(colecao, { nome: "x" })).toEqual({ nome: "x" });
  });

  test("classe base cifrada vale pelo model da subclasse", () => {
    const nomes = nomesMapeados();
    expect(nomes).toContain("cofre_filho");
    expect(nomes).not.toContain("CofreBase");
  });

  test("static prismaModel não é herdado: a subclasse sem ele usa o próprio nome", () => {
    @InitFields
    class CofreNetoModel extends CofreFilhoModel {}
    void CofreNetoModel;
    expect(nomesMapeados()).toContain("CofreNeto");
  });
});

describe("Prisma 7: o client registrado confere as classes cifradas", () => {
  afterEach(() => setPrismaClient({ $transaction: async (fn: any) => fn({}) }));

  const delegate = { fields: { id: { modelName: "Outro" } } };
  const clientCom = (nomes: string[]) => ({
    $transaction: async (fn: any) => fn({}),
    _runtimeDataModel: { models: Object.fromEntries(nomes.map((nome) => [nome, {}])) },
  });

  test("model ausente no client: UNMAPPED_MODEL", () => {
    setPrismaClient(clientCom([...nomesMapeados("CofreErrado"), "Outro"]));
    expect(() => encodeRowForCollection(delegate, { nome: "x" })).toThrow("CofreErradoModel");
  });

  test("todos presentes: passa", () => {
    setPrismaClient(clientCom([...nomesMapeados(), "Outro"]));
    expect(encodeRowForCollection(delegate, { nome: "x" })).toEqual({ nome: "x" });
  });
});

describe("checkEncryptedModels: a conferência no boot", () => {
  test("lança com a classe e o nome procurado; passa com todos", () => {
    expect(() => checkEncryptedModels(nomesMapeados("CofreErrado"))).toThrow("CofreErradoModel");
    expect(() => checkEncryptedModels(nomesMapeados())).not.toThrow();
  });
});

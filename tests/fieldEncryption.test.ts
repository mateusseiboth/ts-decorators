import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getModel, ModelTagged } from "../src/decorators/getModel";
import { Field, InitFields } from "../src/decorators/initFields";
import { applyMask } from "../src/decorators/maskSensitive";
import {
  EncryptionError,
  configureEncryption,
  countByEncryptionKey,
  decryptValue,
  encryptValue,
  isEncryptedValue,
  keyFingerprint,
  listEncryptionKeys,
  reencryptColumn,
  resetEncryption,
} from "../src/fields/encryption";
import { executePrismaQuery } from "../src/functions/sql";
import { updateById } from "../src/functions/updateById";
import { getOrderBy } from "../src/middlwares/getOrderBy";
import { getWhere } from "../src/middlwares/getWhere";
import { readRows } from "../src/prisma8/query";
import { decodeRowsForCollection, encodeRowForCollection } from "../src/prisma8/temporal";
import { FakeCollection } from "../src/testing/prisma8Fakes";
import { mockNext, mockReq, mockRes } from "./_helpers";

type Row = Record<string, unknown>;

// Chaves de 32 bytes em base64, como sairiam de `openssl rand -base64 32`.
const K1 = Buffer.alloc(32, 1).toString("base64");
const K2 = Buffer.alloc(32, 2).toString("base64");

/** O model cifrado dos testes: a senha do certificado A1 e os dados bancários. */
@InitFields
class CertificadoCifradoModel {
  static prismaModel = "CertificadoCifrado";
  @Field("string") id!: string;
  @Field({ type: "string", encrypted: true }) senha!: string;
  @Field({ type: "number", encrypted: true }) agencia!: number;
  @Field({ type: "object", encrypted: true }) conta!: { banco: string; numero: string };
  @Field("string") nome!: string;
}

/** Sem `static prismaModel`: o nome do model do Prisma sai da classe sem o sufixo `Model`. */
@InitFields
class ContaBancariaModel {
  @Field("string") id!: string;
  @Field({ encrypted: true }) chavePix!: string;
}

// Os models só registram o @Field: o teste usa as colunas pelo nome do model do Prisma.
void CertificadoCifradoModel;
void ContaBancariaModel;

const MODELS8 = {
  CertificadoCifrado: { fields: ["id", "senha", "agencia", "conta", "nome"] },
};

const colecao = (rows?: Row[]) => new FakeCollection(MODELS8, "CertificadoCifrado", { rows });

/** Delegate do Prisma 7 (`tx.certificadoCifrado`): o nome do model vem em `fields`. */
function fakeDelegate7(modelName: string, rows: Row[]) {
  const calls: Array<[string, any]> = [];
  return {
    calls,
    fields: { id: { modelName } },
    async findMany(args: any) {
      calls.push(["findMany", args]);
      return args.select?.id ? rows.map((row) => ({ id: row.id })) : rows;
    },
    async count() {
      return rows.length;
    },
    async updateMany(args: any) {
      calls.push(["updateMany", args]);
      return { count: 1 };
    },
    async findFirst(args: any) {
      calls.push(["findFirst", args]);
      return rows[0] ?? null;
    },
  };
}

beforeEach(() => {
  resetEncryption();
  configureEncryption({ keys: { k1: K1 }, current: "k1" });
});

afterEach(() => resetEncryption());

describe("cifra do valor", () => {
  test("ida e volta de texto, número e objeto", () => {
    for (const valor of ["minha senha", 1234, { banco: "001", numero: "12-3" }, ""]) {
      const cifrado = encryptValue(valor);
      expect(isEncryptedValue(cifrado)).toBe(true);
      expect(decryptValue(cifrado)).toEqual(valor);
    }
  });

  test("null e undefined passam intactos", () => {
    expect(encryptValue(null)).toBeNull();
    expect(encryptValue(undefined)).toBeUndefined();
    expect(decryptValue(null)).toBeNull();
  });

  test("formato versionado com a impressão digital da chave", () => {
    const cifrado = encryptValue("x") as string;
    const [prefixo, versao, kid, iv, dado] = cifrado.split(":");
    expect(`${prefixo}:${versao}`).toBe("enc:v1");
    expect(kid).toBe(keyFingerprint(K1));
    expect(Buffer.from(iv!, "base64url")).toHaveLength(12);
    expect(dado!.length).toBeGreaterThan(0);
  });

  test("o IV muda a cada gravação: o mesmo valor gera textos diferentes", () => {
    const a = encryptValue("mesma senha") as string;
    const b = encryptValue("mesma senha") as string;
    expect(a).not.toBe(b);
    expect(a.split(":")[3]).not.toBe(b.split(":")[3]);
  });

  test("a impressão digital vem da chave, não do rótulo", () => {
    expect(keyFingerprint(K1)).not.toBe(keyFingerprint(K2));
    expect(keyFingerprint(K1)).toBe(keyFingerprint(Buffer.alloc(32, 1).toString("base64url")));
    expect(keyFingerprint(K1)).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  test("valor legado em texto puro: a leitura devolve como está", () => {
    expect(decryptValue("senha antiga")).toBe("senha antiga");
    expect(decryptValue(42)).toBe(42);
  });
});

describe("troca de chave", () => {
  test("lê o que a chave antiga gravou e grava com a atual", () => {
    const antigo = encryptValue("segredo") as string;

    configureEncryption({ keys: { k1: K1, k2: K2 }, current: "k2" });
    expect(decryptValue(antigo)).toBe("segredo");
    const novo = encryptValue("segredo") as string;
    expect(novo.split(":")[2]).toBe(keyFingerprint(K2));
  });

  test("chave errada com o MESMO rótulo não tenta decifrar: erro de chave não configurada", () => {
    const gravado = encryptValue("segredo") as string;
    configureEncryption({ keys: { k1: K2 }, current: "k1" });

    expect(() => decryptValue(gravado, "senha")).toThrow(EncryptionError);
    expect(() => decryptValue(gravado, "senha")).toThrow(
      `Chave ${keyFingerprint(K1)} não configurada`,
    );
  });

  test("listEncryptionKeys mostra rótulo, impressão digital e qual é a atual", () => {
    configureEncryption({ keys: { k1: K1, k2: K2 }, current: "k2" });
    expect(listEncryptionKeys()).toEqual([
      { label: "k1", id: keyFingerprint(K1), current: false },
      { label: "k2", id: keyFingerprint(K2), current: true },
    ]);
  });
});

describe("configuração", () => {
  test("sem configuração: erro claro na gravação e na leitura, nunca texto puro", () => {
    const cifrado = encryptValue("x");
    resetEncryption();

    expect(() => encryptValue("x")).toThrow("configureEncryption");
    expect(() => decryptValue(cifrado)).toThrow("configureEncryption");
    expect(() => decryptValue("legado")).toThrow("configureEncryption");
    expect(() => encodeRowForCollection(colecao(), { senha: "x" })).toThrow(EncryptionError);
  });

  test("chave fora do tamanho, vazia ou atual ausente: erro no boot", () => {
    const curta = Buffer.alloc(16, 1).toString("base64");
    expect(() => configureEncryption({ keys: { k1: curta }, current: "k1" })).toThrow("32 bytes");
    expect(() => configureEncryption({ keys: { k1: undefined }, current: "k1" })).toThrow("vazia");
    expect(() => configureEncryption({ keys: { k1: "não é base64!" }, current: "k1" })).toThrow(
      "32 bytes",
    );
    expect(() => configureEncryption({ keys: { k1: K1 }, current: "k2" })).toThrow('"k2"');
    expect(() => configureEncryption({ keys: {}, current: "k1" })).toThrow(EncryptionError);
  });
});

describe("adulteração", () => {
  test("GCM recusa o dado alterado: erro claro, sem devolver lixo", () => {
    const cifrado = encryptValue("segredo") as string;
    const partes = cifrado.split(":");
    const dado = Buffer.from(partes[4]!, "base64url");
    dado[0] = dado[0]! ^ 0xff;
    partes[4] = dado.toString("base64url");

    expect(() => decryptValue(partes.join(":"), "senha")).toThrow(EncryptionError);
    expect(() => decryptValue(partes.join(":"), "senha")).toThrow("senha");
  });

  test("texto com o prefixo mas fora do formato também é recusado", () => {
    expect(() => decryptValue("enc:v1:abc")).toThrow(EncryptionError);
  });
});

describe("Prisma 8: o caminho único de gravação e leitura", () => {
  test("encodeRowForCollection cifra só os campos encrypted; a leitura decifra", () => {
    const linha = encodeRowForCollection(colecao(), {
      id: "c1",
      senha: "a1-senha",
      agencia: 1234,
      conta: { banco: "001", numero: "9" },
      nome: "Prefeitura",
    });

    expect(linha.id).toBe("c1");
    expect(linha.nome).toBe("Prefeitura");
    for (const campo of ["senha", "agencia", "conta"]) {
      expect(isEncryptedValue(linha[campo])).toBe(true);
    }

    const lida = readRows(colecao() as never, [linha]) as Row[];
    expect(lida[0]).toEqual({
      id: "c1",
      senha: "a1-senha",
      agencia: 1234,
      conta: { banco: "001", numero: "9" },
      nome: "Prefeitura",
    });
  });

  test("legado em texto puro é lido como está; a próxima gravação cifra", () => {
    const lida = decodeRowsForCollection(colecao(), { id: "c1", senha: "antiga" }) as Row;
    expect(lida.senha).toBe("antiga");
    expect(isEncryptedValue(encodeRowForCollection(colecao(), lida).senha)).toBe(true);
  });

  test("relação incluída decifra com o model da relação", () => {
    const models = {
      Empresa: { fields: ["id"], relations: { certificados: "CertificadoCifrado" } },
      ...MODELS8,
    };
    const empresa = new FakeCollection(models, "Empresa");
    const senha = encryptValue("na relação");
    const lida = decodeRowsForCollection(empresa, {
      id: "e1",
      certificados: [{ id: "c1", senha }],
    }) as { certificados: Row[] };
    expect(lida.certificados[0]!.senha).toBe("na relação");
  });

  test("updateById cifra o payload do update", async () => {
    const col = colecao([{ id: "c1" }]);
    await updateById(col, "c1", { senha: "nova" });
    const [escrita] = col.writes;
    expect(isEncryptedValue((escrita!.data as Row).senha)).toBe(true);
  });

  test("model sem static prismaModel casa pelo nome da classe sem o sufixo Model", () => {
    const col = new FakeCollection(
      { ContaBancaria: { fields: ["id", "chavePix"] } },
      "ContaBancaria",
    );
    const linha = encodeRowForCollection(col, { id: "x", chavePix: "pix@x" });
    expect(isEncryptedValue(linha.chavePix)).toBe(true);
  });
});

describe("Prisma 7: o mesmo caminho pelo delegate", () => {
  test("encodeRowForCollection e decodeRowsForCollection aceitam o delegate", () => {
    const delegate = fakeDelegate7("CertificadoCifrado", []);
    const linha = encodeRowForCollection(delegate, { id: "c1", senha: "p7" });
    expect(isEncryptedValue(linha.senha)).toBe(true);
    expect((decodeRowsForCollection(delegate, [linha]) as Row[])[0]!.senha).toBe("p7");
  });

  test("executePrismaQuery devolve a listagem decifrada", async () => {
    const delegate = fakeDelegate7("CertificadoCifrado", [
      { id: "c1", senha: encryptValue("listada"), nome: "A" },
    ]);
    const pagina = await executePrismaQuery<Row>(delegate, { take: 10, skip: 0, page: 1 });
    expect(pagina.data.data[0]!.senha).toBe("listada");
  });

  test("updateById cifra o updateMany e devolve a linha relida decifrada", async () => {
    const delegate = fakeDelegate7("CertificadoCifrado", [
      { id: "c1", senha: encryptValue("relida") },
    ]);
    const row = await updateById(delegate, "c1", { senha: "gravada" });
    const [, update] = delegate.calls[0]!;
    expect(isEncryptedValue(update.data.senha)).toBe(true);
    expect(row!.senha).toBe("relida");
  });
});

describe("consequências protegidas", () => {
  @InitFields
  @ModelTagged
  class SegredoFiltroModel {
    static tag = 9801;
    @Field("string") nome!: string;
    @Field({ type: "string", encrypted: true }) senha!: string;
  }
  const classBase = {
    getModel: () => getModel(SegredoFiltroModel.tag),
    tag: SegredoFiltroModel.tag,
  };

  test("getWhere recusa filtro em campo cifrado com o campo no path", () => {
    const res = mockRes();
    const next = mockNext();
    getWhere(mockReq({ query: { senha: "x" } }), res, next, classBase);
    expect(next.called).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res._body.errors[0].path).toBe("senha");
    expect(res._body.errors[0].message).not.toContain("—");
  });

  test("getOrderBy ignora ordenação por campo cifrado", () => {
    const res = mockRes();
    getOrderBy(
      mockReq({ query: { orderBy: "senha", orderMethod: "asc" } }),
      res,
      mockNext(),
      classBase,
    );
    expect(res.locals.orderBy).toEqual([]);
  });

  test("applyMask mascara o campo cifrado mesmo sem @MaskSensitive", () => {
    const mascarado = applyMask({ nome: "A", senha: "aberta" }, SegredoFiltroModel);
    expect(mascarado.senha).toBe("******");
    expect(mascarado.nome).toBe("A");
  });
});

describe("recifrar em lote", () => {
  function tabela(valores: unknown[]) {
    const linhas = valores.map((value, indice) => ({ id: indice + 1, value }));
    return {
      linhas,
      read: async (after: unknown, limit: number) =>
        linhas.filter((linha) => linha.id > ((after as number) ?? 0)).slice(0, limit),
      write: async (id: unknown, value: string) => {
        linhas.find((linha) => linha.id === id)!.value = value;
      },
    };
  }

  test("conta por chave, recifra o que não está na atual e relata o que sobrou", async () => {
    const naK1 = encryptValue("um");
    configureEncryption({ keys: { k1: K1, k2: K2 }, current: "k2" });
    const naK2 = encryptValue("dois");
    const t = tabela([naK1, naK2, "legado", null, naK1]);

    const previa = await reencryptColumn({ read: t.read, write: t.write, dryRun: true });
    expect(previa).toEqual({
      read: 5,
      rewritten: 0,
      before: { k1: 2, k2: 1, plain: 1, empty: 1 },
      after: { k1: 2, k2: 1, plain: 1, empty: 1 },
    });

    const relatorio = await reencryptColumn({ read: t.read, write: t.write, batchSize: 2 });
    expect(relatorio.rewritten).toBe(3);
    expect(relatorio.after).toEqual({ k2: 4, empty: 1 });
    expect(t.linhas.map((linha) => decryptValue(linha.value))).toEqual([
      "um",
      "dois",
      "legado",
      null,
      "um",
    ]);
    expect(countByEncryptionKey(t.linhas.map((linha) => linha.value))).toEqual({ k2: 4, empty: 1 });
  });

  test("valor de chave desconhecida fica como está e aparece no relatório pela impressão digital", async () => {
    configureEncryption({ keys: { velha: K2 }, current: "velha" });
    const desconhecido = encryptValue("x");
    configureEncryption({ keys: { k1: K1 }, current: "k1" });
    const t = tabela([desconhecido]);

    const relatorio = await reencryptColumn({ read: t.read, write: t.write });
    expect(relatorio.rewritten).toBe(0);
    expect(relatorio.after).toEqual({ [keyFingerprint(K2)]: 1 });
    expect(t.linhas[0]!.value).toBe(desconhecido);
  });
});

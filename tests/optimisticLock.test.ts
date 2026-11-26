import { beforeEach, describe, expect, test } from "bun:test";

import { DAOFor, ModelTagged } from "../src/decorators/getModel";
import { ClientError } from "../src/errors/commons";
import { OptimisticLockError } from "../src/errors/optimisticLock";
import { readIfMatch, updateById } from "../src/functions/updateById";
import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import {
  FakeCollection,
  fakeCombinators,
  fakeDb8,
  type FakeContractModels,
  type FakeState,
} from "../src/testing/prisma8Fakes";
import { mockReq } from "./_helpers";

type Row = Record<string, unknown>;

const VERSAO = "2026-01-10T14:30:00.123Z";
const instante = (iso: string, mais = 0) => new Date(new Date(iso).getTime() + mais);

@ModelTagged
class ImovelLockModel {
  static tag = 9301;
}

@DAOFor(ImovelLockModel.tag, { optimisticLock: true })
class ImovelLockDAO {}

@ModelTagged
class ParcelaLockModel {
  static tag = 9302;
}

@DAOFor(ParcelaLockModel.tag, { optimisticLock: true, versionColumn: "updatedAt" })
class ParcelaLockDAO {}

@ModelTagged
class BairroLockModel {
  static tag = 9303;
}

@DAOFor(BairroLockModel.tag)
class BairroLockDAO {}

/** Delegate do Prisma 7 (`tx.imovel`): o que o `updateById` usa dele. */
function fakeDelegate(count: number, linha: Row | null) {
  const calls: Array<[string, any]> = [];
  return {
    calls,
    async updateMany(args: any) {
      calls.push(["updateMany", args]);
      return { count };
    },
    async findFirst(args: any) {
      calls.push(["findFirst", args]);
      return linha;
    },
  };
}

const ALTERADO = {
  statusCode: 409,
  code: "REGISTRO_ALTERADO",
  message: "O registro foi alterado por outro usuário. Recarregue a tela e tente de novo.",
};

describe("updateById no Prisma 7", () => {
  test("com a trava e a versão no corpo: UPDATE condicional e a linha relida", async () => {
    const delegate = fakeDelegate(1, { id: "i1", nome: "B" });
    const row = await updateById(
      delegate,
      "i1",
      { nome: "B", updated_at: VERSAO },
      { dao: new ImovelLockDAO() },
    );

    expect(row).toEqual({ id: "i1", nome: "B" });
    const [, update] = delegate.calls[0];
    expect(update.where).toEqual({
      id: "i1",
      updated_at: { gte: instante(VERSAO), lt: instante(VERSAO, 1) },
    });
    // A versão antiga não volta para o banco: a coluna recebe o instante da gravação.
    expect(update.data.nome).toBe("B");
    expect(update.data.updated_at).toBeInstanceOf(Date);
    expect(update.data.updated_at.getTime()).toBeGreaterThan(instante(VERSAO).getTime());
    expect(delegate.calls[1]).toEqual(["findFirst", { where: { id: "i1" } }]);
  });

  test("nenhuma linha afetada e o registro existe: OptimisticLockError", async () => {
    const delegate = fakeDelegate(0, { id: "i1" });
    const promessa = updateById(delegate, "i1", { updated_at: VERSAO }, { dao: ImovelLockDAO });

    await expect(promessa).rejects.toBeInstanceOf(OptimisticLockError);
    await expect(promessa).rejects.toMatchObject(ALTERADO);
  });

  test("nenhuma linha afetada e o registro não existe: null (o 404 de sempre)", async () => {
    const delegate = fakeDelegate(0, null);
    expect(
      await updateById(delegate, "i1", { updated_at: VERSAO }, { dao: ImovelLockDAO }),
    ).toBeNull();
  });

  test("com a trava e sem versão no pedido: atualiza sem conferir", async () => {
    const delegate = fakeDelegate(0, null);
    expect(await updateById(delegate, "i1", { nome: "B" }, { dao: ImovelLockDAO })).toBeNull();

    expect(delegate.calls).toHaveLength(1);
    expect(delegate.calls[0][1].where).toEqual({ id: "i1" });
  });

  test("version (do If-Match) vence o campo do corpo", async () => {
    const delegate = fakeDelegate(1, { id: "i1" });
    const outra = "2026-01-10T15:00:00.000Z";
    await updateById(
      delegate,
      "i1",
      { updated_at: VERSAO },
      { dao: ImovelLockDAO, version: `"${outra}"` },
    );

    expect(delegate.calls[0][1].where.updated_at).toEqual({
      gte: instante(outra),
      lt: instante(outra, 1),
    });
  });

  test("versionColumn escolhe a coluna", async () => {
    const delegate = fakeDelegate(1, { id: "p1" });
    await updateById(delegate, "p1", { valor: 10, updatedAt: VERSAO }, { dao: ParcelaLockDAO });

    const { where, data } = delegate.calls[0][1];
    expect(where).toEqual({
      id: "p1",
      updatedAt: { gte: instante(VERSAO), lt: instante(VERSAO, 1) },
    });
    expect(data.updatedAt).toBeInstanceOf(Date);
  });

  test("DAO sem a trava: o update de sempre, com o corpo como veio", async () => {
    const delegate = fakeDelegate(1, { id: "b1" });
    await updateById(delegate, "b1", { nome: "B", updated_at: VERSAO }, { dao: BairroLockDAO });

    expect(delegate.calls[0][1]).toEqual({
      where: { id: "b1" },
      data: { nome: "B", updated_at: VERSAO },
    });
  });

  test("sem dao: o update de sempre", async () => {
    const delegate = fakeDelegate(1, { id: "b1" });
    await updateById(delegate, "b1", { nome: "B" });
    expect(delegate.calls[0][1]).toEqual({ where: { id: "b1" }, data: { nome: "B" } });
  });

  test("versão que não é data: ClientError antes de gravar", async () => {
    const delegate = fakeDelegate(1, { id: "i1" });
    const promessa = updateById(delegate, "i1", { updated_at: "ontem" }, { dao: ImovelLockDAO });

    await expect(promessa).rejects.toBeInstanceOf(ClientError);
    await expect(promessa).rejects.toThrow(
      "A versão do registro é inválida. Recarregue a tela e tente de novo.",
    );
    expect(delegate.calls).toEqual([]);
  });
});

describe("updateById no Prisma 8", () => {
  const models: FakeContractModels = { Imovel: { fields: ["id", "nome", "updated_at"] } };

  beforeEach(() => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
  });

  /** O filtro tem a versão quando há um `gte` na árvore do where. */
  const hasFiltroDaVersao = (state: FakeState) => JSON.stringify(state.where).includes('"gte"');

  test("UPDATE condicional na coleção; devolve a linha alterada", async () => {
    const col = new FakeCollection(models, "Imovel", { rows: [{ id: "i1", nome: "A" }] });
    const row = await updateById(
      col,
      "i1",
      { nome: "B", updated_at: VERSAO },
      { dao: ImovelLockDAO },
    );

    expect(row).toMatchObject({ id: "i1", nome: "B" });
    const [update] = col.writes;
    expect(update.terminal).toBe("update");
    expect(hasFiltroDaVersao(update.state)).toBe(true);
    expect((update.data as Row).updated_at).toBeInstanceOf(Date);
  });

  test("o payload sai sem chave undefined (o Prisma 8 recusa)", async () => {
    const col = new FakeCollection(models, "Imovel", { rows: [{ id: "i1" }] });
    await updateById(col, "i1", { nome: "B", apelido: undefined });
    expect(col.writes[0].data).toEqual({ nome: "B" });
  });

  test("alterado por outro: OptimisticLockError", async () => {
    const col = new FakeCollection(models, "Imovel", {
      rows: (state) => (hasFiltroDaVersao(state) ? [] : [{ id: "i1" }]),
    });
    const promessa = updateById(col, "i1", { updated_at: VERSAO }, { dao: ImovelLockDAO });
    await expect(promessa).rejects.toMatchObject(ALTERADO);
  });

  test("registro inexistente: null", async () => {
    const col = new FakeCollection(models, "Imovel", { rows: [] });
    expect(await updateById(col, "i1", { updated_at: VERSAO }, { dao: ImovelLockDAO })).toBeNull();
  });
});

describe("readIfMatch", () => {
  const reqCom = (valor?: string) => {
    const r = mockReq({ method: "PUT" });
    r.header = (nome: string) => (nome.toLowerCase() === "if-match" ? valor : undefined);
    return r;
  };

  test("tira as aspas e o W/ do ETag", () => {
    expect(readIfMatch(reqCom(`"${VERSAO}"`))).toBe(VERSAO);
    expect(readIfMatch(reqCom(`W/"${VERSAO}"`))).toBe(VERSAO);
    expect(readIfMatch(reqCom(VERSAO))).toBe(VERSAO);
  });

  test("sem o cabeçalho, ou com *, não há versão", () => {
    expect(readIfMatch(reqCom())).toBeUndefined();
    expect(readIfMatch(reqCom("*"))).toBeUndefined();
  });
});

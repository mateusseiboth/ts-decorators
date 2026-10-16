import { describe, expect, test } from "bun:test";

import { makePrismaOptions } from "../src/functions/makePrismaOptions";
import { applyColumnProjection, executePrismaQuery } from "../src/functions/sql";
import { buildSelectFromFields, getColumns } from "../src/middlwares/getColumns";
import { mockNext, mockReq, mockRes } from "./_helpers";
import { RuaModel, UserModel } from "./_models";

/** Prisma delegate fake: guarda os argumentos de cada findMany para inspeção. */
function mockDelegate(rows: any[] = [{ id: "1" }]) {
  const calls: any[] = [];
  return {
    calls,
    findMany: async (args: any) => {
      calls.push(args);
      return rows;
    },
    count: async () => rows.length,
  };
}

describe("getColumns", () => {
  test("monta select a partir de ?fields=id,name", () => {
    const req = mockReq({ query: { fields: "id,name" } });
    const res = mockRes();
    const next = mockNext();

    getColumns(req, res, next, RuaModel);

    expect(next.called).toBe(true);
    expect(res.locals.columns).toEqual({ id: true, name: true });
  });

  test("sem ?fields não toca em res.locals", () => {
    const res = mockRes();
    const next = mockNext();

    getColumns(mockReq(), res, next, RuaModel);

    expect(next.called).toBe(true);
    expect(res.locals.columns).toBeUndefined();
  });

  test("ignora campo que não existe no model", () => {
    const req = mockReq({ query: { fields: "name,senhaSecreta" } });
    const res = mockRes();

    getColumns(req, res, mockNext(), RuaModel);

    expect(res.locals.columns).toEqual({ id: true, name: true });
  });

  test("não seta columns quando nenhum campo pedido é válido", () => {
    const req = mockReq({ query: { fields: "naoExiste" } });
    const res = mockRes();

    getColumns(req, res, mockNext(), RuaModel, { always: [] });

    expect(res.locals.columns).toBeUndefined();
  });

  test("id entra por padrão e pode ser desligado via always", () => {
    const comId = mockRes();
    getColumns(mockReq({ query: { fields: "name" } }), comId, mockNext(), RuaModel);
    expect(comId.locals.columns).toEqual({ id: true, name: true });

    const semId = mockRes();
    getColumns(mockReq({ query: { fields: "name" } }), semId, mockNext(), RuaModel, { always: [] });
    expect(semId.locals.columns).toEqual({ name: true });
  });

  test("aceita separador ; e valores repetidos na query", () => {
    const porPontoEVirgula = mockRes();
    getColumns(mockReq({ query: { fields: "id;name" } }), porPontoEVirgula, mockNext(), RuaModel);
    expect(porPontoEVirgula.locals.columns).toEqual({ id: true, name: true });

    const repetido = mockRes();
    getColumns(mockReq({ query: { fields: ["id", "name"] } }), repetido, mockNext(), RuaModel);
    expect(repetido.locals.columns).toEqual({ id: true, name: true });
  });

  test("campo aninhado vira select da relação", () => {
    const res = mockRes();

    getColumns(mockReq({ query: { fields: "id,bairro.name" } }), res, mockNext(), RuaModel);

    expect(res.locals.columns).toEqual({ id: true, bairro: { select: { name: true } } });
  });

  test("relação inteira prevalece sobre campo isolado da relação", () => {
    const res = mockRes();

    getColumns(mockReq({ query: { fields: "bairro,bairro.name" } }), res, mockNext(), RuaModel, {
      always: [],
    });

    expect(res.locals.columns).toEqual({ bairro: true });
  });

  test("queryKey customizada", () => {
    const res = mockRes();

    getColumns(mockReq({ query: { colunas: "name" } }), res, mockNext(), RuaModel, {
      queryKey: "colunas",
      always: [],
    });

    expect(res.locals.columns).toEqual({ name: true });
  });

  test("relação to-many declarada por @Field([Model])", () => {
    const res = mockRes();

    getColumns(mockReq({ query: { fields: "id,posts.title" } }), res, mockNext(), UserModel);

    expect(res.locals.columns).toEqual({ id: true, posts: { select: { title: true } } });
  });
});

describe("buildSelectFromFields", () => {
  test("retorna undefined quando nada é válido", () => {
    expect(buildSelectFromFields(["inexistente"], RuaModel)).toBeUndefined();
  });

  test("usa o model como whitelist", () => {
    expect(buildSelectFromFields(["id", "cep", "hack"], RuaModel)).toEqual({ id: true, cep: true });
  });
});

describe("makePrismaOptions + columns", () => {
  test("repassa columns quando o getColumns rodou", () => {
    const res = mockRes();
    res.locals.columns = { id: true, name: true };

    expect(makePrismaOptions(res).columns).toEqual({ id: true, name: true });
  });

  test("não cria a chave columns quando não há projeção", () => {
    expect("columns" in makePrismaOptions(mockRes())).toBe(false);
  });
});

describe("applyColumnProjection", () => {
  test("vira select e remove include quando não há select próprio", () => {
    const options: any = { columns: { id: true, name: true }, include: { bairro: true } };

    applyColumnProjection(options);

    expect(options.select).toEqual({ id: true, name: true });
    expect(options.include).toBeUndefined();
    expect("columns" in options).toBe(false);
  });

  test("só estreita o select do DAO (campo fora da whitelist não vaza)", () => {
    const options: any = {
      columns: { id: true, password: true },
      select: { id: true, email: true },
    };

    applyColumnProjection(options);

    expect(options.select).toEqual({ id: true });
  });

  test("mantém a query original quando a interseção fica vazia", () => {
    const options: any = { columns: { password: true }, select: { id: true, email: true } };

    applyColumnProjection(options);

    expect(options.select).toEqual({ id: true, email: true });
  });

  test("preserva a restrição do DAO na relação pedida", () => {
    const options: any = {
      columns: { construcoes: { select: { ordem: true } } },
      select: { id: true, construcoes: { where: { enabled: true } } },
    };

    applyColumnProjection(options);

    expect(options.select).toEqual({
      construcoes: { where: { enabled: true }, select: { ordem: true } },
    });
  });

  test("relação pedida inteira herda o select restrito do DAO", () => {
    const options: any = {
      columns: { construcoes: true },
      select: { construcoes: { select: { ordem: true } } },
    };

    applyColumnProjection(options);

    expect(options.select).toEqual({ construcoes: { select: { ordem: true } } });
  });

  test("campo do distinct entra na projeção", () => {
    const options: any = { columns: { name: true }, distinct: ["exercicio"] };

    applyColumnProjection(options);

    expect(options.select).toEqual({ name: true, exercicio: true });
  });

  test("sem columns a query segue intacta", () => {
    const options: any = { select: { id: true }, include: undefined };

    applyColumnProjection(options);

    expect(options.select).toEqual({ id: true });
  });
});

describe("executePrismaQuery + columns", () => {
  test("aplica a projeção na busca dos dados", async () => {
    const delegate = mockDelegate([{ id: "1" }]);

    await executePrismaQuery(
      delegate as any,
      {
        where: { enabled: true },
        columns: { id: true, name: true },
        include: { bairro: true },
        page: 1,
        take: 10,
      } as any,
    );

    const [idsQuery, dataQuery] = delegate.calls;
    expect(idsQuery.select).toEqual({ id: true });
    expect(dataQuery.select).toEqual({ id: true, name: true });
    expect(dataQuery.include).toBeUndefined();
  });

  test("sem columns mantém o include do DAO", async () => {
    const delegate = mockDelegate([{ id: "1" }]);

    await executePrismaQuery(
      delegate as any,
      { where: {}, include: { bairro: true }, page: 1, take: 10 } as any,
    );

    expect(delegate.calls[1].include).toEqual({ bairro: true });
    expect(delegate.calls[1].select).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  executePrismaQuery,
  invalidateCountCache,
  setDeriveTotalDefault,
} from "../src/functions/sql";
import { setHandlerContext } from "../src/handlers/context";

interface DelegateOptions {
  /** Total real no banco, quando o `count` chega a ser consultado. */
  total?: number;
  /** Segura a busca das LINHAS até `releaseRows()` — prova que o count não espera por ela. */
  hangRows?: boolean;
}

function mockDelegate(ids: any[], options: DelegateOptions & { model?: string } = {}) {
  const findManyCalls: any[] = [];
  const countCalls: any[] = [];
  let releaseRows!: () => void;
  const rowsGate = new Promise<void>((resolve) => {
    releaseRows = resolve;
  });

  return {
    findManyCalls,
    countCalls,
    releaseRows,
    // O Prisma expõe o nome do model em qualquer campo do delegate.
    fields: { id: { modelName: options.model ?? "Registro", name: "id" } },
    findMany: async (args: any) => {
      findManyCalls.push(args);
      if (findManyCalls.length === 2 && options.hangRows) await rowsGate;
      return ids;
    },
    count: async (args: any) => {
      countCalls.push(args);
      return options.total ?? ids.length;
    },
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1) }));

describe("executePrismaQuery — o PADRÃO não mexe no comportamento histórico", () => {
  test("a contagem vai ao banco mesmo com a página incompleta", async () => {
    const delegate = mockDelegate(ids(3), { total: 3 });

    const result: any = await executePrismaQuery(
      delegate as any,
      {
        where: { enabled: true },
        page: 1,
        skip: 0,
        take: 10,
      } as any,
    );

    expect(delegate.countCalls.length).toBe(1);
    expect(result.data.paginacao.totalPage).toBe(3);
  });

  test("o count só sai DEPOIS das linhas — nada de paralelismo por padrão", async () => {
    const delegate = mockDelegate(ids(10), { total: 50, hangRows: true });

    const pending = executePrismaQuery(
      delegate as any,
      {
        where: {},
        page: 1,
        skip: 0,
        take: 10,
      } as any,
    );

    await Bun.sleep(5);
    expect(delegate.countCalls.length).toBe(0);

    delegate.releaseRows();
    await pending;
    expect(delegate.countCalls.length).toBe(1);
  });

  test("setDeriveTotalDefault liga a dedução para o processo inteiro", async () => {
    setDeriveTotalDefault(true);
    try {
      const delegate = mockDelegate(ids(3));
      await executePrismaQuery(delegate as any, { where: {}, page: 1, skip: 0, take: 10 } as any);
      expect(delegate.countCalls.length).toBe(0);
    } finally {
      setDeriveTotalDefault(false);
    }
  });
});

describe("executePrismaQuery — com deriveTotal ligado", () => {
  test("página INCOMPLETA não consulta count: o total já é conhecido", async () => {
    const delegate = mockDelegate(ids(3));

    const result: any = await executePrismaQuery(
      delegate as any,
      {
        where: { enabled: true },
        page: 1,
        skip: 0,
        take: 10,
        deriveTotal: true,
      } as any,
    );

    expect(delegate.countCalls.length).toBe(0);
    expect(delegate.findManyCalls.length).toBe(2);
    expect(result.data.paginacao.totalPage).toBe(3);
  });

  test("página incompleta com skip soma o deslocamento ao total", async () => {
    const delegate = mockDelegate(ids(4));

    const result: any = await executePrismaQuery(
      delegate as any,
      {
        where: {},
        page: 3,
        skip: 20,
        take: 10,
        deriveTotal: true,
      } as any,
    );

    expect(delegate.countCalls.length).toBe(0);
    expect(result.data.paginacao.totalPage).toBe(24);
  });

  test("SEM take (consulta não paginada) o total é o que veio", async () => {
    const delegate = mockDelegate(ids(7));

    const result: any = await executePrismaQuery(
      delegate as any,
      {
        where: {},
        deriveTotal: true,
      } as any,
    );

    expect(delegate.countCalls.length).toBe(0);
    expect(result.data.paginacao.totalPage).toBe(7);
  });

  test("página CHEIA consulta o count — pode haver mais registros", async () => {
    const delegate = mockDelegate(ids(10), { total: 137 });

    const result: any = await executePrismaQuery(
      delegate as any,
      {
        where: { enabled: true },
        page: 1,
        skip: 0,
        take: 10,
        deriveTotal: true,
      } as any,
    );

    expect(delegate.countCalls.length).toBe(1);
    expect(delegate.countCalls[0]).toEqual({ where: { enabled: true } });
    expect(result.data.paginacao.totalPage).toBe(137);
    expect(result.data.paginacao.total).toBe(14); // ceil(137 / 10)
  });

  test("linhas e count saem JUNTOS — o count não espera as linhas", async () => {
    const delegate = mockDelegate(ids(10), { total: 50, hangRows: true });

    const pending = executePrismaQuery(
      delegate as any,
      {
        where: {},
        page: 1,
        skip: 0,
        take: 10,
        deriveTotal: true,
      } as any,
    );

    // Se fossem sequenciais, o count só sairia depois das linhas — que estão travadas.
    await Bun.sleep(5);
    expect(delegate.countCalls.length).toBe(1);

    delegate.releaseRows();
    const result: any = await pending;
    expect(result.data.paginacao.totalPage).toBe(50);
  });

  test("resultado vazio: uma consulta só, sem linhas e sem count", async () => {
    const delegate = mockDelegate([]);

    const result: any = await executePrismaQuery(
      delegate as any,
      {
        where: {},
        page: 1,
        skip: 0,
        take: 10,
        deriveTotal: true,
      } as any,
    );

    expect(delegate.findManyCalls.length).toBe(1);
    expect(delegate.countCalls.length).toBe(0);
    expect(result).toEqual({ data: [], paginate: { totalPage: 0, page: 1, total: 0 } });
  });
});

describe("executePrismaQuery — formato da resposta", () => {
  test("mantém data.data + paginacao e converte BigInt", async () => {
    const delegate = mockDelegate([{ id: "1", sequencial: BigInt(9) }], { total: 11 });

    const result: any = await executePrismaQuery(
      delegate as any,
      {
        where: {},
        page: 2,
        skip: 10,
        take: 10,
      } as any,
    );

    expect(result.data.data).toEqual([{ id: "1", sequencial: "9" }]);
    expect(result.data.paginacao).toEqual({ totalPage: 11, page: 2, total: 2 });
  });

  test("a busca das linhas filtra pelos ids da primeira consulta", async () => {
    const delegate = mockDelegate(ids(2));

    await executePrismaQuery(
      delegate as any,
      {
        where: { enabled: true },
        orderBy: [{ id: "asc" }],
        page: 1,
        skip: 0,
        take: 10,
      } as any,
    );

    const [idsQuery, rowsQuery] = delegate.findManyCalls;
    expect(idsQuery.select).toEqual({ id: true });
    expect(idsQuery.take).toBe(10);
    expect(rowsQuery.where).toEqual({ id: { in: ["1", "2"] } });
    expect(rowsQuery.orderBy).toEqual([{ id: "asc" }]);
    expect(rowsQuery.take).toBeUndefined();
  });
});

describe("executePrismaQuery — cache da contagem", () => {
  const paginado = { where: { enabled: true }, page: 1, skip: 0, take: 2, deriveTotal: true };

  beforeEach(() => {
    invalidateCountCache();
    setHandlerContext(() => ({ entity: 10 }));
  });
  afterEach(() => {
    invalidateCountCache();
    setHandlerContext(() => undefined);
  });

  test("sem countTtlMs (padrão) NUNCA reaproveita a contagem", async () => {
    const a = mockDelegate(ids(2), { total: 500 });
    const b = mockDelegate(ids(2), { total: 500 });

    await executePrismaQuery(a as any, { ...paginado });
    await executePrismaQuery(b as any, { ...paginado });

    expect(a.countCalls.length).toBe(1);
    expect(b.countCalls.length).toBe(1);
  });

  test("com countTtlMs, a página seguinte reaproveita a contagem", async () => {
    const pagina1 = mockDelegate(ids(2), { total: 500 });
    const pagina2 = mockDelegate(ids(2), { total: 500 });

    const r1: any = await executePrismaQuery(pagina1 as any, { ...paginado, countTtlMs: 5_000 });
    const r2: any = await executePrismaQuery(pagina2 as any, {
      ...paginado,
      page: 2,
      skip: 2,
      countTtlMs: 5_000,
    });

    expect(pagina1.countCalls.length).toBe(1);
    expect(pagina2.countCalls.length).toBe(0);
    expect(r1.data.paginacao.totalPage).toBe(500);
    expect(r2.data.paginacao.totalPage).toBe(500);
  });

  test("filtro diferente conta de novo", async () => {
    const a = mockDelegate(ids(2), { total: 500 });
    const b = mockDelegate(ids(2), { total: 7 });

    await executePrismaQuery(a as any, { ...paginado, countTtlMs: 5_000 });
    const r: any = await executePrismaQuery(b as any, {
      ...paginado,
      where: { enabled: true, name: "Ana" },
      countTtlMs: 5_000,
    });

    expect(b.countCalls.length).toBe(1);
    expect(r.data.paginacao.totalPage).toBe(7);
  });

  test("ENTIDADE diferente conta de novo — total de um município não vaza para outro", async () => {
    const ent10 = mockDelegate(ids(2), { total: 500 });
    const ent20 = mockDelegate(ids(2), { total: 33 });

    await executePrismaQuery(ent10 as any, { ...paginado, countTtlMs: 5_000 });
    setHandlerContext(() => ({ entity: 20 }));
    const r: any = await executePrismaQuery(ent20 as any, { ...paginado, countTtlMs: 5_000 });

    expect(ent20.countCalls.length).toBe(1);
    expect(r.data.paginacao.totalPage).toBe(33);
  });

  test("MODEL diferente conta de novo", async () => {
    const contribuinte = mockDelegate(ids(2), { total: 500, model: "Contribuinte" });
    const imovel = mockDelegate(ids(2), { total: 90, model: "Imovel" });

    await executePrismaQuery(contribuinte as any, { ...paginado, countTtlMs: 5_000 });
    const r: any = await executePrismaQuery(imovel as any, { ...paginado, countTtlMs: 5_000 });

    expect(imovel.countCalls.length).toBe(1);
    expect(r.data.paginacao.totalPage).toBe(90);
  });

  test("TTL vencido volta a contar", async () => {
    const a = mockDelegate(ids(2), { total: 500 });
    const b = mockDelegate(ids(2), { total: 501 });

    await executePrismaQuery(a as any, { ...paginado, countTtlMs: 1 });
    await Bun.sleep(15);
    const r: any = await executePrismaQuery(b as any, { ...paginado, countTtlMs: 1 });

    expect(b.countCalls.length).toBe(1);
    expect(r.data.paginacao.totalPage).toBe(501);
  });

  test("invalidateCountCache(model) derruba só aquele model", async () => {
    const contribuinte = mockDelegate(ids(2), { total: 500, model: "Contribuinte" });
    const imovel = mockDelegate(ids(2), { total: 90, model: "Imovel" });
    await executePrismaQuery(contribuinte as any, { ...paginado, countTtlMs: 5_000 });
    await executePrismaQuery(imovel as any, { ...paginado, countTtlMs: 5_000 });

    invalidateCountCache("Contribuinte");

    const c2 = mockDelegate(ids(2), { total: 999, model: "Contribuinte" });
    const i2 = mockDelegate(ids(2), { total: 90, model: "Imovel" });
    await executePrismaQuery(c2 as any, { ...paginado, countTtlMs: 5_000 });
    await executePrismaQuery(i2 as any, { ...paginado, countTtlMs: 5_000 });

    expect(c2.countCalls.length).toBe(1);
    expect(i2.countCalls.length).toBe(0);
  });

  test("total DERIVADO (página curta) também alimenta o cache", async () => {
    const curta = mockDelegate(ids(1), { total: 999 });
    const cheia = mockDelegate(ids(2), { total: 999 });

    await executePrismaQuery(curta as any, { ...paginado, countTtlMs: 5_000 });
    expect(curta.countCalls.length).toBe(0);

    const r: any = await executePrismaQuery(cheia as any, { ...paginado, countTtlMs: 5_000 });
    expect(cheia.countCalls.length).toBe(0);
    expect(r.data.paginacao.totalPage).toBe(1);
  });
});

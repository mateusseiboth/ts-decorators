import { describe, expect, test } from "bun:test";

import { createWhereConditionQuery, getWhere } from "../src/middlwares/getWhere";
import { mockNext, mockReq, mockRes } from "./_helpers";
import { SimpleModel } from "./_models";

const whereOf = (valor: string, tipo = "number") =>
  createWhereConditionQuery(valor, "campo", { campo: tipo });

const inicioDoDia = (ano: number, mes: number, dia: number) => new Date(ano, mes - 1, dia);
const fimDoDia = (ano: number, mes: number, dia: number) =>
  new Date(ano, mes - 1, dia, 23, 59, 59, 999);

describe("getWhere: todo operador de OPTIONS_FILTER tem tradução", () => {
  test("greaterThanOrEqual vira gte", () => {
    expect(whereOf("greaterThanOrEqual:10").OR).toEqual([{ campo: { gte: 10 } }]);
  });

  test("lessThanOrEqual vira lte", () => {
    expect(whereOf("lessThanOrEqual:10").OR).toEqual([{ campo: { lte: 10 } }]);
  });

  test("notIn vira notIn", () => {
    expect(whereOf("notIn:1,2,3").OR).toEqual([{ campo: { notIn: [1, 2, 3] } }]);
  });

  test("notInRange nega o intervalo", () => {
    const { OR, NOT } = whereOf("notInRange:10-20");
    expect(OR).toEqual([]);
    expect(NOT).toEqual([{ campo: { gte: 10, lte: 20 } }]);
  });

  test("notNull vira not null", () => {
    expect(whereOf("notNull:true").OR).toEqual([{ campo: { not: null } }]);
  });

  test("isNull continua equals null", () => {
    expect(whereOf("isNull:true").OR).toEqual([{ campo: { equals: null } }]);
  });

  test("containing é o mesmo que contains", () => {
    expect(whereOf("containing:rua", "string").OR).toEqual([
      { campo: { contains: "rua", mode: "insensitive" } },
    ]);
  });
});

describe("getWhere: campo numérico", () => {
  test("in separa a lista pela vírgula", () => {
    expect(whereOf("in:1,2,3").OR).toEqual([{ campo: { in: [1, 2, 3] } }]);
  });

  test("in com decimais", () => {
    expect(whereOf("in:1.5,2.25").OR).toEqual([{ campo: { in: [1.5, 2.25] } }]);
  });

  test("inRange vira um intervalo só", () => {
    expect(whereOf("inRange:10-20").OR).toEqual([{ campo: { gte: 10, lte: 20 } }]);
  });

  test("intervalo sem prefixo vira gte/lte, sem expandir valor a valor", () => {
    expect(whereOf("1-5").OR).toEqual([{ campo: { gte: 1, lte: 5 } }]);
  });

  test("intervalo gigante não vira uma condição por número", () => {
    expect(whereOf("1-100000000").OR).toHaveLength(1);
  });

  test("intervalo negado", () => {
    const { OR, NOT } = whereOf("!1-5");
    expect(OR).toEqual([]);
    expect(NOT).toEqual([{ campo: { gte: 1, lte: 5 } }]);
  });

  test("número negativo é um número, não um intervalo", () => {
    expect(whereOf("-5").OR).toEqual([{ campo: { equals: -5 } }]);
  });

  test("intervalo entre negativos", () => {
    expect(whereOf("-5--1").OR).toEqual([{ campo: { gte: -5, lte: -1 } }]);
  });

  test("vários valores continuam virando um OR", () => {
    expect(whereOf("1;2;3").OR).toEqual([
      { campo: { equals: 1 } },
      { campo: { equals: 2 } },
      { campo: { equals: 3 } },
    ]);
  });
});

describe("getWhere: negação", () => {
  test("! depois do prefixo", () => {
    const { OR, NOT } = whereOf("in:!1,2");
    expect(OR).toEqual([]);
    expect(NOT).toEqual([{ campo: { in: [1, 2] } }]);
  });

  test("! antes do prefixo", () => {
    const { OR, NOT } = whereOf("!in:1,2");
    expect(OR).toEqual([]);
    expect(NOT).toEqual([{ campo: { in: [1, 2] } }]);
  });

  test("! em texto simples", () => {
    expect(whereOf("!baixada", "string").NOT).toEqual([{ campo: { equals: "baixada" } }]);
  });
});

describe("getWhere: campo de data", () => {
  test("igualdade cobre o dia informado, no fuso do processo", () => {
    expect(whereOf("2026-01-15", "date").OR).toEqual([
      { campo: { gte: inicioDoDia(2026, 1, 15), lte: fimDoDia(2026, 1, 15) } },
    ]);
  });

  test("igualdade no formato brasileiro", () => {
    expect(whereOf("15/01/2026", "date").OR).toEqual([
      { campo: { gte: inicioDoDia(2026, 1, 15), lte: fimDoDia(2026, 1, 15) } },
    ]);
  });

  test("greaterThanOrEqual parte do começo do dia", () => {
    expect(whereOf("greaterThanOrEqual:2026-01-15", "date").OR).toEqual([
      { campo: { gte: inicioDoDia(2026, 1, 15) } },
    ]);
  });

  test("lessThanOrEqual vai até o fim do dia", () => {
    expect(whereOf("lessThanOrEqual:2026-01-15", "date").OR).toEqual([
      { campo: { lte: fimDoDia(2026, 1, 15) } },
    ]);
  });

  test("greaterThan é depois do fim do dia", () => {
    expect(whereOf("greaterThan:2026-01-15", "date").OR).toEqual([
      { campo: { gt: fimDoDia(2026, 1, 15) } },
    ]);
  });

  test("lessThan é antes do começo do dia", () => {
    expect(whereOf("lessThan:2026-01-15", "date").OR).toEqual([
      { campo: { lt: inicioDoDia(2026, 1, 15) } },
    ]);
  });

  test("com hora, o instante é exato", () => {
    expect(whereOf("greaterThan:2026-01-15T10:30:00", "date").OR).toEqual([
      { campo: { gt: new Date(2026, 0, 15, 10, 30, 0) } },
    ]);
  });

  test("inRange com datas ISO", () => {
    expect(whereOf("inRange:2026-01-01-2026-01-31", "date").OR).toEqual([
      { campo: { gte: inicioDoDia(2026, 1, 1), lte: fimDoDia(2026, 1, 31) } },
    ]);
  });

  test("inRange com datas no formato brasileiro", () => {
    expect(whereOf("inRange:01/01/2026-31/01/2026", "date").OR).toEqual([
      { campo: { gte: inicioDoDia(2026, 1, 1), lte: fimDoDia(2026, 1, 31) } },
    ]);
  });

  test("vale para os tipos de data do Temporal", () => {
    expect(whereOf("greaterThanOrEqual:2026-01-15", "plaindate").OR).toEqual([
      { campo: { gte: inicioDoDia(2026, 1, 15) } },
    ]);
  });
});

describe("getWhere: valor inválido é recusado", () => {
  const erroDe = (valor: string, tipo: string) => {
    try {
      whereOf(valor, tipo);
      return null;
    } catch (erro) {
      return erro as Error & { path?: string };
    }
  };

  test.each([
    ["dia que não existe", "2026-02-31"],
    ["dia que não existe, formato brasileiro", "31/02/2026"],
    ["texto", "abc"],
    ["comparação com data inválida", "greaterThanOrEqual:2026-13-01"],
    ["intervalo com ponta inválida", "inRange:2026-01-01-2026-02-31"],
    ["intervalo sem prefixo", "2026-01-01-2026-01-31"],
    ["lista com item inválido", "in:2026-01-15,abc"],
  ])("data: %s", (_caso, valor) => {
    const erro = erroDe(valor, "date");
    expect(erro?.message).toBe('Informe uma data válida no filtro "campo".');
    expect(erro?.path).toBe("campo");
  });

  test.each([
    ["vírgula decimal", "1,5"],
    ["texto", "abc"],
    ["número com moeda", "R$ 1.234,56"],
    ["intervalo sem fim", "10-"],
    ["dois pontos decimais", "1.2.3"],
    ["comparação com texto", "greaterThan:abc"],
    ["lista com item inválido", "in:1,abc,3"],
    ["busca por texto em campo numérico", "contains:abc"],
  ])("número: %s", (_caso, valor) => {
    const erro = erroDe(valor, "number");
    expect(erro?.message).toBe('Informe um número válido no filtro "campo".');
    expect(erro?.path).toBe("campo");
  });

  test("número válido continua aceito, com espaço em volta", () => {
    expect(whereOf(" 42 ").OR).toEqual([{ campo: { equals: 42 } }]);
    expect(whereOf("-1.5").OR).toEqual([{ campo: { equals: -1.5 } }]);
    expect(whereOf("in:1, 2").OR).toEqual([{ campo: { in: [1, 2] } }]);
  });

  test("isNull e notNull não olham o valor", () => {
    expect(whereOf("isNull:qualquer").OR).toEqual([{ campo: { equals: null } }]);
    expect(whereOf("notNull:qualquer", "date").OR).toEqual([{ campo: { not: null } }]);
  });

  test("texto continua livre", () => {
    expect(whereOf("R$ 1,5", "string").OR).toEqual([{ campo: { equals: "R$ 1,5" } }]);
  });
});

describe("getWhere (middleware): filtro inválido responde 400", () => {
  test("não chama o next e devolve o campo e a mensagem", () => {
    const next = mockNext();
    const res = mockRes();
    getWhere(mockReq({ query: { age: "abc", name: "Maria" } }), res, next, SimpleModel as any);

    expect(next.called).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res._body).toEqual({
      message: "Filtro inválido.",
      errors: [{ path: "age", message: 'Informe um número válido no filtro "age".' }],
    });
    expect(res.locals.where).toBeUndefined();
  });

  test("filtro válido segue como antes", () => {
    const next = mockNext();
    const res = mockRes();
    getWhere(mockReq({ query: { age: "30" } }), res, next, SimpleModel as any);

    expect(next.called).toBe(true);
    expect(res.locals.where).toEqual({ OR: [{ age: { equals: 30 } }] });
  });
});

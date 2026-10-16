import { beforeEach, describe, expect, test } from "bun:test";

import { convertBigIntValues } from "../src/functions/sql";
import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import {
  datesFromTemporal,
  decodeForCodec,
  decodeRowsForCollection,
  encodeForCodec,
  encodeRowForCollection,
  isTemporal,
  temporalToDate,
  temporalToIso,
} from "../src/prisma8/temporal";
import { buildPredicate } from "../src/prisma8/where";
import { fakeCombinators, fakeContract, fakeDb8, fakeProxy } from "../src/testing/prisma8Fakes";

const ISO = "2026-07-13T12:04:46.218Z";

describe("encodeForCodec — Date/ISO viram o Temporal do codec", () => {
  test("timestamp sem fuso vira PlainDateTime no horário UTC", () => {
    const out = encodeForCodec(new Date(ISO), "pg/timestamp-temporal@1") as Temporal.PlainDateTime;
    expect(out).toBeInstanceOf(Temporal.PlainDateTime);
    expect(out.toString({ fractionalSecondDigits: 3 })).toBe("2026-07-13T12:04:46.218");
  });

  test("timestamptz vira Instant; date vira PlainDate", () => {
    expect(encodeForCodec(ISO, "pg/timestamptz-temporal@1")).toBeInstanceOf(Temporal.Instant);
    const date = encodeForCodec(new Date(ISO), "pg/date-temporal@1") as Temporal.PlainDate;
    expect(date.toString()).toBe("2026-07-13");
  });

  test("Temporal passa direto; null e codec não temporal ficam como estão", () => {
    const pdt = Temporal.PlainDateTime.from("2026-01-01T00:00:00");
    expect(encodeForCodec(pdt, "pg/timestamp-temporal@1")).toBe(pdt);
    expect(encodeForCodec(null, "pg/timestamp-temporal@1")).toBeNull();
    expect(encodeForCodec("texto", "pg/text@1")).toBe("texto");
    expect(encodeForCodec(new Date(ISO), undefined)).toBeInstanceOf(Date);
  });

  test("data inválida falha alto", () => {
    expect(() => encodeForCodec("não é data", "pg/timestamp-temporal@1")).toThrow(/inválida/);
  });
});

describe("temporalToIso — o mesmo texto que o Prisma 7 mandava", () => {
  test("PlainDateTime ganha o Z; Instant e ZonedDateTime saem em UTC; PlainDate à meia-noite UTC", () => {
    expect(temporalToIso(Temporal.PlainDateTime.from("2026-07-13T12:04:46.218"))).toBe(ISO);
    expect(temporalToIso(Temporal.Instant.from(ISO))).toBe(ISO);
    expect(
      temporalToIso(Temporal.Instant.from(ISO).toZonedDateTimeISO("America/Campo_Grande")),
    ).toBe(ISO);
    expect(temporalToIso(Temporal.PlainDate.from("2026-07-13"))).toBe("2026-07-13T00:00:00.000Z");
  });

  test("sempre três casas de milissegundo, como Date.toISOString()", () => {
    expect(temporalToIso(Temporal.PlainDateTime.from("2026-07-13T12:04:46"))).toBe(
      "2026-07-13T12:04:46.000Z",
    );
  });

  test("temporalToDate e datesFromTemporal em profundidade", () => {
    expect(
      temporalToDate(Temporal.PlainDateTime.from("2026-07-13T12:04:46.218")).toISOString(),
    ).toBe(ISO);
    const rows = [
      {
        createdAt: Temporal.Instant.from(ISO),
        nested: { d: Temporal.PlainDate.from("2026-07-13") },
      },
    ];
    const out = datesFromTemporal(rows);
    expect(out[0]!.createdAt).toBeInstanceOf(Date);
    expect((out[0]!.nested.d as unknown as Date).toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(isTemporal(out[0]!.createdAt)).toBe(false);
  });
});

describe("convertBigIntValues serializa Temporal como Date", () => {
  test("linha com bigint, Date e Temporal", () => {
    const out = convertBigIntValues({
      sequencial: 10n,
      antes: new Date(ISO),
      agora: Temporal.PlainDateTime.from("2026-07-13T12:04:46.218"),
      lista: [Temporal.Instant.from(ISO)],
    });
    expect(out).toEqual({ sequencial: "10", antes: ISO, agora: ISO, lista: [ISO] });
  });
});

describe("encodeRowForCollection — pelo contrato da coleção", () => {
  test("converte só as colunas temporais do model", () => {
    const collection = {
      contract: fakeContract({ Bairro: { fields: ["id", "createdAt"] } }),
      modelName: "Bairro",
      namespaceId: "public",
    };
    (
      collection.contract.domain.namespaces.public.models.Bairro.fields.createdAt as {
        type: unknown;
      }
    ).type = {
      kind: "scalar",
      codecId: "pg/timestamp-temporal@1",
    };
    const out = encodeRowForCollection(collection, {
      id: "x",
      createdAt: new Date(ISO),
      name: "n",
    });
    expect(out.id).toBe("x");
    expect(out.name).toBe("n");
    expect(out.createdAt).toBeInstanceOf(Temporal.PlainDateTime);
  });

  test("coleção sem contrato (fake) devolve o payload intacto", () => {
    const row = { createdAt: new Date(ISO) };
    expect(encodeRowForCollection({}, row).createdAt).toBeInstanceOf(Date);
  });
});

describe("where: Date no filtro vira Temporal pelo codec do campo", () => {
  beforeEach(() => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
  });

  test("gte/lte/eq/in convertem pelo codec do proxy", () => {
    const proxy = fakeProxy({ Bairro: { fields: ["id", "createdAt"] } }, "Bairro");
    proxy.createdAt.codec = { codecId: "pg/timestamp-temporal@1" };
    const predicate = buildPredicate(proxy, {
      createdAt: { gte: new Date(ISO), lte: "2026-12-31T23:59:59.999Z" },
    }) as { args: Array<{ value: unknown }> };
    expect(predicate.args[0]!.value).toBeInstanceOf(Temporal.PlainDateTime);
    expect(predicate.args[1]!.value).toBeInstanceOf(Temporal.PlainDateTime);
    const lista = buildPredicate(proxy, { createdAt: { in: [new Date(ISO)] } }) as {
      value: unknown[];
    };
    expect(lista.value[0]).toBeInstanceOf(Temporal.PlainDateTime);
  });

  test("campo sem codec temporal não mexe no valor", () => {
    const proxy = fakeProxy({ Bairro: { fields: ["id", "name"] } }, "Bairro");
    expect(buildPredicate(proxy, { name: "x" })).toEqual({ op: "eq", field: "name", value: "x" });
  });
});

describe("enums: rótulo na aplicação, valor no banco", () => {
  const enums = { tipoTributacao: { TRIBUTADO: "01", ISENTO: "03" } };
  const codec = { codecId: "pg/enum@1", typeParams: { typeName: "tipoTributacao" } };
  beforeEach(() => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators, enums });
  });

  test("encodeForCodec troca o rótulo pelo valor; valor já gravado e desconhecido passam", () => {
    expect(encodeForCodec("ISENTO", codec)).toBe("03");
    expect(encodeForCodec("03", codec)).toBe("03");
    expect(encodeForCodec("OUTRA_COISA", codec)).toBe("OUTRA_COISA");
    expect(encodeForCodec(null, codec)).toBeNull();
  });

  test("decodeForCodec troca o valor pelo rótulo; sem mapa fica como veio", () => {
    expect(decodeForCodec("03", codec)).toBe("ISENTO");
    expect(decodeForCodec("99", codec)).toBe("99");
    expect(decodeForCodec("03", { codecId: "pg/text@1" })).toBe("03");
  });

  test("where traduz o rótulo pelo codec do proxy", () => {
    const proxy = fakeProxy({ ImovelUrbano: { fields: ["id", "tipoTributacao"] } }, "ImovelUrbano");
    proxy.tipoTributacao.codec = codec;
    expect(buildPredicate(proxy, { tipoTributacao: "ISENTO" })).toEqual({
      op: "eq",
      field: "tipoTributacao",
      value: "03",
    });
    expect(buildPredicate(proxy, { tipoTributacao: { in: ["TRIBUTADO", "ISENTO"] } })).toEqual({
      op: "in",
      field: "tipoTributacao",
      value: ["01", "03"],
    });
  });

  test("decodeRowsForCollection percorre linha, lista e relação incluída pelo contrato", () => {
    const contract = fakeContract({
      ImovelUrbano: { fields: ["id", "tipoTributacao"], relations: { bairro: "Bairro" } },
      Bairro: { fields: ["id", "categoria"] },
    });
    const models = contract.domain.namespaces.public.models as Record<
      string,
      { fields: Record<string, { type?: unknown }> }
    >;
    models.ImovelUrbano!.fields.tipoTributacao!.type = codec;
    models.Bairro!.fields.categoria!.type = codec;
    const collection = { contract, modelName: "ImovelUrbano", namespaceId: "public" };
    const rows = [
      { id: "1", tipoTributacao: "03", bairro: { id: "b", categoria: "01" } },
      { id: "2", tipoTributacao: "01", bairro: null },
    ];
    expect(decodeRowsForCollection(collection, rows)).toEqual([
      { id: "1", tipoTributacao: "ISENTO", bairro: { id: "b", categoria: "TRIBUTADO" } },
      { id: "2", tipoTributacao: "TRIBUTADO", bairro: null },
    ]);
  });

  test("encodeRowForCollection traduz enum e data juntos", () => {
    const contract = fakeContract({ ImovelUrbano: { fields: ["tipoTributacao", "createdAt"] } });
    const models = contract.domain.namespaces.public.models as Record<
      string,
      { fields: Record<string, { type?: unknown }> }
    >;
    models.ImovelUrbano!.fields.tipoTributacao!.type = codec;
    models.ImovelUrbano!.fields.createdAt!.type = { codecId: "pg/timestamp-temporal@1" };
    const out = encodeRowForCollection(
      { contract, modelName: "ImovelUrbano", namespaceId: "public" },
      { tipoTributacao: "ISENTO", createdAt: new Date(ISO) },
    );
    expect(out.tipoTributacao).toBe("03");
    expect(out.createdAt).toBeInstanceOf(Temporal.PlainDateTime);
  });
});

/**
 * O Prisma 8 decodifica `numeric` como STRING decimal (`"412.6600"`), e não há codec que devolva
 * número. Quem guarda dinheiro e quantidade em `numeric` e faz conta com eles liga
 * `numericAsNumber`: a leitura devolve `number`, e `a + b` continua sendo soma — não
 * concatenação. É opt-in: sem ele, o texto segue como o Prisma 8 entrega.
 */
describe("numeric: number na aplicação com numericAsNumber", () => {
  const numeric = { codecId: "pg/numeric@1" };

  test("sem a opção, numeric continua texto", () => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
    expect(decodeForCodec("412.6600", numeric)).toBe("412.6600");
  });

  test("com a opção, numeric vira number; nulo continua nulo", () => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators, numericAsNumber: true });
    expect(decodeForCodec("412.6600", numeric)).toBe(412.66);
    expect(decodeForCodec("-0.5", numeric)).toBe(-0.5);
    expect(decodeForCodec(null, numeric)).toBeNull();
    expect(decodeForCodec("412.6600", { codecId: "pg/text@1" })).toBe("412.6600");
  });

  /**
   * A escrita recebe o `number` que a leitura devolveu. O codec exige texto numérico CANÔNICO
   * (`"412.66"`, nunca `"1e-7"`): o número vira esse texto, e a coluna arredonda na escala dela.
   */
  test("encodeForCodec: number vira texto numérico canônico; texto passa", () => {
    expect(encodeForCodec(412.66, numeric)).toBe("412.66");
    expect(encodeForCodec(-3, numeric)).toBe("-3");
    expect(encodeForCodec(0.0000001, numeric)).toBe("0.0000001");
    expect(encodeForCodec(1e21, numeric)).toBe("1000000000000000000000");
    expect(encodeForCodec("412.6600", numeric)).toBe("412.6600");
    expect(encodeForCodec(null, numeric)).toBeNull();
  });

  test("decodeRowsForCollection converte na linha e na relação incluída", () => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators, numericAsNumber: true });
    const contract = fakeContract({
      estoques: { fields: ["id", "quantidade_atual"], relations: { produtos: "produtos" } },
      produtos: { fields: ["id", "estoque_minimo"] },
    });
    const models = contract.domain.namespaces.public.models as Record<
      string,
      { fields: Record<string, { type?: unknown }> }
    >;
    models.estoques!.fields.quantidade_atual!.type = numeric;
    models.produtos!.fields.estoque_minimo!.type = numeric;
    const collection = { contract, modelName: "estoques", namespaceId: "public" };

    expect(
      decodeRowsForCollection(collection, [
        { id: "e1", quantidade_atual: "412.6600", produtos: [{ id: "p1", estoque_minimo: "10" }] },
      ]),
    ).toEqual([
      { id: "e1", quantidade_atual: 412.66, produtos: [{ id: "p1", estoque_minimo: 10 }] },
    ]);
  });
});

describe("encodeForCodec — bigint (pg/int8@1) aceita number e string numérica", () => {
  // O parser da query string entrega `Number("728")` e o codec do Prisma 8 exige `bigint`:
  // `sequencial=contains:728` estourava com RUNTIME.ENCODE_FAILED na listagem.
  test("number inteiro vira bigint", () => {
    expect(encodeForCodec(728, "pg/int8@1")).toBe(728n);
    expect(encodeForCodec(0, "pg/int8@1")).toBe(0n);
    expect(encodeForCodec(-5, { codecId: "pg/int8@1" })).toBe(-5n);
  });

  test("string numérica vira bigint; bigint, null e undefined passam", () => {
    expect(encodeForCodec("728", "pg/int8@1")).toBe(728n);
    expect(encodeForCodec(" 42 ", "pg/int8@1")).toBe(42n);
    expect(encodeForCodec(9n, "pg/int8@1")).toBe(9n);
    expect(encodeForCodec(null, "pg/int8@1")).toBeNull();
    expect(encodeForCodec(undefined, "pg/int8@1")).toBeUndefined();
  });

  test("o que não é inteiro segue como veio, para o codec recusar com a mensagem dele", () => {
    expect(encodeForCodec(1.5, "pg/int8@1")).toBe(1.5);
    expect(encodeForCodec("abc", "pg/int8@1")).toBe("abc");
    expect(encodeForCodec("", "pg/int8@1")).toBe("");
  });

  test("outros codecs numéricos não são tocados", () => {
    expect(encodeForCodec(728, "pg/int4@1")).toBe(728);
    expect(encodeForCodec("728", "pg/text@1")).toBe("728");
  });
});

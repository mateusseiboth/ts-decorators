import "reflect-metadata";
import { beforeEach, describe, expect, test } from "bun:test";

import { clearLegacyWarnings } from "./_proxy";
import { AutoConvert, convertPrimitive } from "./autoConvert";
import { Field } from "./initFields";

// ---------------------------------------------------------------------------
// Models de teste (usam os próprios decorators do pacote, no padrão legacy).
// ---------------------------------------------------------------------------

class RuaModel {
  @Field("string") id!: string;
  @Field("string") nome!: string;
  @Field("number") numero!: number;
  @Field("boolean") ativa!: boolean;
  @Field("date") criadaEm!: Date;

  @AutoConvert
  setData(data: any) {
    Object.assign(this, data);
    return this;
  }
}

class EnderecoModel {
  @Field("string") cep!: string;
  // relação to-one → @Field(RuaModel)
  @Field(RuaModel) rua!: RuaModel;
  // relação to-many → @Field([RuaModel])
  @Field([RuaModel]) ruas!: RuaModel[];

  @AutoConvert
  setData(data: any) {
    Object.assign(this, data);
    return this;
  }
}

class CidadeModel {
  @Field("string") nome!: string;
  // aninhamento profundo: Cidade → Endereco → Rua
  @Field(EnderecoModel) endereco!: EnderecoModel;

  @AutoConvert
  setData(data: any) {
    Object.assign(this, data);
    return this;
  }
}

// ---------------------------------------------------------------------------
// convertPrimitive
// ---------------------------------------------------------------------------

describe("convertPrimitive - number", () => {
  test("converte string numérica", () => {
    expect(convertPrimitive("number", "42")).toBe(42);
  });
  test("converte float", () => {
    expect(convertPrimitive("number", "3.14")).toBe(3.14);
  });
  test("valor não numérico vira null", () => {
    expect(convertPrimitive("number", "abc")).toBeNull();
  });
  test("respeita case-insensitive do tipo", () => {
    expect(convertPrimitive("NUMBER", "7")).toBe(7);
  });
});

describe("convertPrimitive - bigint", () => {
  test("converte string inteira", () => {
    expect(convertPrimitive("bigint", "10")).toBe(10n);
  });
  test("converte number", () => {
    expect(convertPrimitive("bigint", 5)).toBe(5n);
  });
  test("valor inválido vira null", () => {
    expect(convertPrimitive("bigint", "x")).toBeNull();
  });
  test("float inválido para bigint vira null", () => {
    expect(convertPrimitive("bigint", "1.5")).toBeNull();
  });
});

describe("convertPrimitive - boolean", () => {
  test.each([
    ["false", false],
    ["0", false],
    [0, false],
    ["N", false],
  ])("falsy %p => false", (input, expected) => {
    expect(convertPrimitive("boolean", input)).toBe(expected);
  });

  test.each([
    ["true", true],
    ["1", true],
    [1, true],
    ["S", true],
  ])("truthy %p => true", (input, expected) => {
    expect(convertPrimitive("boolean", input)).toBe(expected);
  });

  test("valor arbitrário cai no Boolean()", () => {
    expect(convertPrimitive("boolean", "qualquer")).toBe(true);
  });
});

describe("convertPrimitive - string", () => {
  test("number vira string", () => {
    expect(convertPrimitive("string", 123)).toBe("123");
  });
  test("boolean vira string", () => {
    expect(convertPrimitive("string", true)).toBe("true");
  });
});

describe("convertPrimitive - date", () => {
  test("BR DD/MM/YYYY", () => {
    const d = convertPrimitive("date", "25/12/2024") as Date;
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(25);
  });
  test("ISO", () => {
    const d = convertPrimitive("date", "2024-12-25T00:00:00.000Z") as Date;
    expect(d.toISOString()).toBe("2024-12-25T00:00:00.000Z");
  });
  test("epoch negativo em milissegundos", () => {
    const d = convertPrimitive("date", -69451200000) as Date;
    expect(d.toISOString()).toBe("1967-10-20T04:00:00.000Z");
  });
  test("data inválida vira null", () => {
    expect(convertPrimitive("date", "não-é-data")).toBeNull();
  });
});

describe("convertPrimitive - edge cases", () => {
  test("null retorna null independente do tipo", () => {
    expect(convertPrimitive("number", null)).toBeNull();
    expect(convertPrimitive("string", null)).toBeNull();
    expect(convertPrimitive("date", null)).toBeNull();
  });
  test("undefined retorna null", () => {
    expect(convertPrimitive("string", undefined)).toBeNull();
  });
  test("tipo desconhecido mantém o valor original", () => {
    const obj = { a: 1 };
    expect(convertPrimitive("qualquer", obj)).toBe(obj);
  });
  test("tipo undefined mantém o valor original", () => {
    expect(convertPrimitive(undefined, "livre")).toBe("livre");
  });
});

// ---------------------------------------------------------------------------
// @AutoConvert (decorator de método sobre setData)
// ---------------------------------------------------------------------------

describe("@AutoConvert - campos primitivos", () => {
  beforeEach(() => clearLegacyWarnings());

  test("converte cada campo conforme o @Field", () => {
    const rua = new RuaModel();
    rua.setData({
      id: 99, // number → string
      nome: "Central",
      numero: "150", // string → number
      ativa: "S", // "S" → true
      criadaEm: "25/12/2024", // BR → Date
    });

    expect(rua.id).toBe("99");
    expect(rua.numero).toBe(150);
    expect(rua.ativa).toBe(true);
    expect(rua.criadaEm).toBeInstanceOf(Date);
    expect((rua.criadaEm as Date).getFullYear()).toBe(2024);
  });

  test("ignora chaves que não são @Field", () => {
    const rua = new RuaModel();
    rua.setData({ numero: "10", desconhecido: "xyz" } as any);
    expect(rua.numero).toBe(10);
    expect((rua as any).desconhecido).toBe("xyz"); // passa direto, sem conversão
  });

  test("data inválida vira null", () => {
    const rua = new RuaModel();
    rua.setData({ criadaEm: "lixo" });
    expect(rua.criadaEm).toBeNull();
  });

  test("setData sem dados não quebra", () => {
    const rua = new RuaModel();
    expect(() => rua.setData(null as any)).not.toThrow();
    expect(() => rua.setData(undefined as any)).not.toThrow();
  });
});

describe("@AutoConvert - nested model @Field(RuaModel)", () => {
  test("instancia e converte relação to-one", () => {
    const end = new EnderecoModel();
    end.setData({
      cep: "88000-000",
      rua: { id: 7, numero: "42", ativa: "N" },
    });

    expect(end.rua).toBeInstanceOf(RuaModel);
    expect(end.rua.id).toBe("7"); // convertido pelo setData aninhado
    expect(end.rua.numero).toBe(42);
    expect(end.rua.ativa).toBe(false);
  });

  test("relação já instanciada é preservada", () => {
    const rua = new RuaModel();
    rua.setData({ id: "1" });
    const end = new EnderecoModel();
    end.setData({ rua });
    expect(end.rua).toBe(rua);
  });

  test("valor único num campo to-one continua objeto único", () => {
    const end = new EnderecoModel();
    end.setData({ rua: { id: "abc" } });
    expect(Array.isArray(end.rua)).toBe(false);
    expect(end.rua).toBeInstanceOf(RuaModel);
  });
});

describe("@AutoConvert - nested list @Field([RuaModel])", () => {
  test("instancia e converte cada item do array", () => {
    const end = new EnderecoModel();
    end.setData({
      ruas: [
        { id: 1, numero: "10" },
        { id: 2, numero: "20" },
      ],
    });

    expect(Array.isArray(end.ruas)).toBe(true);
    expect(end.ruas).toHaveLength(2);
    expect(end.ruas[0]).toBeInstanceOf(RuaModel);
    expect(end.ruas[0]!.id).toBe("1");
    expect(end.ruas[0]!.numero).toBe(10);
    expect(end.ruas[1]!.numero).toBe(20);
  });

  test("valor único num campo de lista é normalizado para array", () => {
    const end = new EnderecoModel();
    end.setData({ ruas: { id: "só-um" } } as any);
    expect(Array.isArray(end.ruas)).toBe(true);
    expect(end.ruas).toHaveLength(1);
    expect(end.ruas[0]).toBeInstanceOf(RuaModel);
  });

  test("array passado para campo to-one é convertido item a item", () => {
    // proteção contra o bug histórico: array em @Field(Model) não vira 1 instância vazia
    const end = new EnderecoModel();
    end.setData({ rua: [{ id: "1" }, { id: "2" }] } as any);
    expect(Array.isArray(end.rua)).toBe(true);
    expect((end.rua as any)[0]).toBeInstanceOf(RuaModel);
    expect((end.rua as any)[0].id).toBe("1");
  });
});

describe("@AutoConvert - aninhamento profundo", () => {
  test("converte recursivamente Cidade → Endereco → Rua", () => {
    const cidade = new CidadeModel();
    cidade.setData({
      nome: "Floripa",
      endereco: {
        cep: "88000-000",
        rua: { id: 5, numero: "77", criadaEm: "01/06/2020" },
      },
    });

    expect(cidade.endereco).toBeInstanceOf(EnderecoModel);
    expect(cidade.endereco.rua).toBeInstanceOf(RuaModel);
    expect(cidade.endereco.rua.id).toBe("5");
    expect(cidade.endereco.rua.numero).toBe(77);
    expect(cidade.endereco.rua.criadaEm).toBeInstanceOf(Date);
    expect((cidade.endereco.rua.criadaEm as Date).getMonth()).toBe(5); // junho
  });

  test("null/undefined em campo aninhado é preservado", () => {
    const end = new EnderecoModel();
    end.setData({ rua: null } as any);
    expect(end.rua).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Temporal
// ---------------------------------------------------------------------------

class AgendaModel {
  @Field("zoneddatetime") inicio!: Temporal.ZonedDateTime;
  @Field("instant") registradoEm!: Temporal.Instant;
  @Field(Temporal.PlainDate) competencia!: Temporal.PlainDate;
  @Field(Temporal.PlainTime) horario!: Temporal.PlainTime;
  @Field("duration") duracao!: Temporal.Duration;

  @AutoConvert
  setData(data: any) {
    Object.assign(this, data);
    return this;
  }
}

describe("convertPrimitive - Temporal", () => {
  test("zoneddatetime mantém a string de data com time zone", () => {
    const value = convertPrimitive("zoneddatetime", "2024-01-15T10:00:00-03:00[America/Sao_Paulo]");
    expect(value).toBeInstanceOf(Temporal.ZonedDateTime);
    expect(String(value)).toBe("2024-01-15T10:00:00-03:00[America/Sao_Paulo]");
  });

  test("aceita o nome qualificado Temporal.ZonedDateTime", () => {
    expect(convertPrimitive("Temporal.ZonedDateTime", "2024-01-15T10:00:00Z")).toBeInstanceOf(
      Temporal.ZonedDateTime,
    );
  });

  test("instant", () => {
    expect(convertPrimitive("instant", "2024-01-15T13:00:00Z")).toBeInstanceOf(Temporal.Instant);
  });

  test("plaindate", () => {
    expect(String(convertPrimitive("plaindate", "15/01/2024"))).toBe("2024-01-15");
  });

  test("plaindatetime", () => {
    expect(String(convertPrimitive("plaindatetime", "2024-01-15T10:30:00"))).toBe(
      "2024-01-15T10:30:00",
    );
  });

  test("plaintime pelo alias time", () => {
    expect(String(convertPrimitive("time", "10:30"))).toBe("10:30:00");
  });

  test("plainyearmonth pelo alias yearmonth", () => {
    expect(String(convertPrimitive("yearmonth", "2024-01-15"))).toBe("2024-01");
  });

  test("plainmonthday pelo alias monthday", () => {
    expect(String(convertPrimitive("monthday", "15/01/2024"))).toBe("01-15");
  });

  test("duration", () => {
    expect(String(convertPrimitive("duration", "PT1H30M"))).toBe("PT1H30M");
  });

  test("valor inválido vira null", () => {
    expect(convertPrimitive("zoneddatetime", "lixo")).toBeNull();
    expect(convertPrimitive("plaindate", null)).toBeNull();
  });
});

describe("@AutoConvert - campos Temporal", () => {
  test("converte cada campo conforme o @Field", () => {
    const agenda = new AgendaModel();
    agenda.setData({
      inicio: "2024-01-15T10:00:00-03:00[America/Sao_Paulo]",
      registradoEm: 1705323600000,
      competencia: "15/01/2024",
      horario: "10:30",
      duracao: "PT2H",
    });

    expect(agenda.inicio.toString()).toBe("2024-01-15T10:00:00-03:00[America/Sao_Paulo]");
    expect(agenda.inicio.timeZoneId).toBe("America/Sao_Paulo");
    expect(agenda.registradoEm.epochMilliseconds).toBe(1705323600000);
    expect(agenda.competencia.toString()).toBe("2024-01-15");
    expect(agenda.horario.toString()).toBe("10:30:00");
    expect(agenda.duracao.toString()).toBe("PT2H");
  });

  test("@Field(Temporal.PlainDate) não é tratado como model aninhado", () => {
    const agenda = new AgendaModel();
    agenda.setData({ competencia: "2024-03-10" });
    expect(agenda.competencia).toBeInstanceOf(Temporal.PlainDate);
  });

  test("serializa mantendo a string com time zone", () => {
    const agenda = new AgendaModel();
    agenda.setData({ inicio: "2024-01-15T10:00:00-03:00[America/Sao_Paulo]" });
    expect(JSON.parse(JSON.stringify({ inicio: agenda.inicio })).inicio).toBe(
      "2024-01-15T10:00:00-03:00[America/Sao_Paulo]",
    );
  });
});

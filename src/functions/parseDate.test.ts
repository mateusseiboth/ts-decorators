import { describe, expect, test } from "bun:test";

import { parseDate } from "./parseDate";

describe("parseDate - formatos válidos", () => {
  test("instância de Date válida é retornada", () => {
    const d = new Date("2024-01-15T00:00:00.000Z");
    expect(parseDate(d)).toBe(d);
  });

  test("BR DD/MM/YYYY", () => {
    const d = parseDate("25/12/2024")!;
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(25);
  });

  test("BR com hora HH:mm", () => {
    const d = parseDate("25/12/2024 14:30")!;
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  test("BR com hora HH:mm:ss", () => {
    const d = parseDate("25/12/2024 14:30:45")!;
    expect(d.getSeconds()).toBe(45);
  });

  test("EUA/ISO YYYY-MM-DD", () => {
    const d = parseDate("2024-12-25")!;
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(11);
    expect(d.getUTCDate()).toBe(25);
  });

  test("ISO 8601 completo", () => {
    expect(parseDate("2024-12-25T14:30:00.000Z")!.toISOString()).toBe("2024-12-25T14:30:00.000Z");
  });

  test("UTC / RFC string", () => {
    expect(parseDate("Wed, 25 Dec 2024 14:30:00 GMT")!.toISOString()).toBe(
      "2024-12-25T14:30:00.000Z",
    );
  });

  test("epoch em segundos (number)", () => {
    expect(parseDate(1735135800)!.toISOString()).toBe("2024-12-25T14:10:00.000Z");
  });

  test("epoch em milissegundos (number)", () => {
    expect(parseDate(1735135800000)!.toISOString()).toBe("2024-12-25T14:10:00.000Z");
  });

  test("epoch negativo em segundos", () => {
    expect(parseDate(-69451200)!.toISOString()).toBe("1967-10-20T04:00:00.000Z");
  });

  test("epoch negativo em milissegundos não é multiplicado novamente", () => {
    expect(parseDate(-69451200000)!.toISOString()).toBe("1967-10-20T04:00:00.000Z");
  });

  test("epoch negativo em milissegundos como string", () => {
    expect(parseDate("-69451200000")!.toISOString()).toBe("1967-10-20T04:00:00.000Z");
  });

  test("epoch como string numérica", () => {
    expect(parseDate("1735135800")!.toISOString()).toBe("2024-12-25T14:10:00.000Z");
  });
});

describe("parseDate - inválidos retornam null", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["sentinela 0", 0],
    ['sentinela "0"', "0"],
    ["string vazia", ""],
    ["só espaços", "   "],
    ["texto qualquer", "não é data"],
    ["BR overflow 31/02", "31/02/2024"],
    ["Invalid Date instance", new Date("nope")],
  ])("%s => null", (_label, input) => {
    expect(parseDate(input as any)).toBeNull();
  });
});

describe("parseDate - só decide null após TODAS as estratégias falharem", () => {
  test("string ambígua com barras que não é BR válida cai como null", () => {
    expect(parseDate("99/99/9999")).toBeNull();
  });

  test("barras interpretadas como US MM/DD quando não são BR válidas", () => {
    // 10/13/2024 não é DD/MM válido (mês 13), mas é MM/DD válido → native resolve
    const d = parseDate("10/13/2024")!;
    expect(d.getMonth()).toBe(9); // outubro
    expect(d.getDate()).toBe(13);
  });

  test("data limítrofe 29/02 em ano bissexto é válida", () => {
    const d = parseDate("29/02/2024")!;
    expect(d.getDate()).toBe(29);
    expect(d.getMonth()).toBe(1);
  });

  test("29/02 em ano não bissexto é rejeitada", () => {
    expect(parseDate("29/02/2023")).toBeNull();
  });
});

describe("parseDate - valores do Temporal", () => {
  test("Temporal.ZonedDateTime vira o mesmo ponto no tempo", () => {
    const zdt = Temporal.ZonedDateTime.from("2024-12-25T11:10:00-03:00[America/Sao_Paulo]");
    expect(parseDate(zdt)!.toISOString()).toBe("2024-12-25T14:10:00.000Z");
  });

  test("Temporal.Instant", () => {
    const instant = Temporal.Instant.from("2024-12-25T14:10:00Z");
    expect(parseDate(instant)!.toISOString()).toBe("2024-12-25T14:10:00.000Z");
  });

  test("Temporal.PlainDate usa o time zone do sistema", () => {
    const d = parseDate(Temporal.PlainDate.from("2024-12-25"))!;
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(25);
    expect(d.getHours()).toBe(0);
  });

  test("Temporal.PlainDateTime usa o time zone do sistema", () => {
    const d = parseDate(Temporal.PlainDateTime.from("2024-12-25T14:30:00"))!;
    expect(d.getDate()).toBe(25);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });
});

describe("parseDate: data ISO sem hora", () => {
  test("é o dia informado no fuso do processo, não em UTC", () => {
    const d = parseDate("2026-01-15")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 0, 15]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
  });

  test("é o mesmo instante da data brasileira equivalente", () => {
    expect(parseDate("2026-01-15")!.getTime()).toBe(parseDate("15/01/2026")!.getTime());
  });

  test("dia que não existe devolve null", () => {
    expect(parseDate("2026-02-31")).toBeNull();
  });

  test("com Z continua sendo o instante em UTC", () => {
    expect(parseDate("2026-01-15T00:00:00Z")!.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
});

describe("parseDate: valor que não é data devolve null, sem lançar", () => {
  test.each([
    ["Temporal.PlainYearMonth", Temporal.PlainYearMonth.from("2026-01")],
    ["Temporal.PlainMonthDay", Temporal.PlainMonthDay.from("01-15")],
    ["Temporal.Duration", Temporal.Duration.from("PT1H")],
    ["Symbol", Symbol("data")],
    ["objeto sem data", { a: 1 }],
    ["true", true],
    ["false", false],
  ])("%s", (_nome, valor) => {
    expect(parseDate(valor)).toBeNull();
  });
});

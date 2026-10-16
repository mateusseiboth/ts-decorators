import { describe, expect, test } from "bun:test";

import {
  getTemporalConverter,
  isDateLikeFieldType,
  isTemporalConstructor,
  parseDuration,
  parseInstant,
  parsePlainDate,
  parsePlainDateTime,
  parsePlainMonthDay,
  parsePlainTime,
  parsePlainYearMonth,
  parseZonedDateTime,
  temporalTypeName,
} from "./parseTemporal";

const SYSTEM_TZ = Temporal.Now.timeZoneId();

// ---------------------------------------------------------------------------
// ZonedDateTime
// ---------------------------------------------------------------------------

describe("parseZonedDateTime", () => {
  test("mantém a string completa com IANA time zone", () => {
    const zdt = parseZonedDateTime("2024-01-15T10:00:00-03:00[America/Sao_Paulo]")!;
    expect(zdt.toString()).toBe("2024-01-15T10:00:00-03:00[America/Sao_Paulo]");
    expect(zdt.timeZoneId).toBe("America/Sao_Paulo");
  });

  test("instância de ZonedDateTime é preservada", () => {
    const zdt = Temporal.ZonedDateTime.from("2024-01-15T10:00:00-03:00[America/Sao_Paulo]");
    expect(parseZonedDateTime(zdt)).toBe(zdt);
  });

  test("string só com offset preserva o offset como time zone", () => {
    const zdt = parseZonedDateTime("2024-01-15T10:00:00-03:00")!;
    expect(zdt.offset).toBe("-03:00");
    expect(zdt.hour).toBe(10);
  });

  test("separador com espaço (formato de banco) também preserva o offset", () => {
    const zdt = parseZonedDateTime("2024-01-15 10:00:00-03:00")!;
    expect(zdt.offset).toBe("-03:00");
    expect(zdt.hour).toBe(10);
  });

  test("string em UTC vira time zone UTC", () => {
    const zdt = parseZonedDateTime("2024-01-15T13:00:00Z")!;
    expect(zdt.timeZoneId).toBe("UTC");
    expect(zdt.hour).toBe(13);
  });

  test("string sem offset usa o time zone do sistema", () => {
    const zdt = parseZonedDateTime("2024-01-15T10:00:00")!;
    expect(zdt.timeZoneId).toBe(SYSTEM_TZ);
    expect(zdt.hour).toBe(10);
  });

  test("string só com a data vira meia-noite do MESMO dia no time zone do sistema", () => {
    const zdt = parseZonedDateTime("2024-01-15")!;
    expect(zdt.timeZoneId).toBe(SYSTEM_TZ);
    expect(zdt.day).toBe(15);
    expect(zdt.hour).toBe(0);
  });

  test("BR DD/MM/YYYY HH:mm usa o time zone do sistema", () => {
    const zdt = parseZonedDateTime("15/01/2024 10:30")!;
    expect(zdt.timeZoneId).toBe(SYSTEM_TZ);
    expect(zdt.day).toBe(15);
    expect(zdt.month).toBe(1);
    expect(zdt.hour).toBe(10);
    expect(zdt.minute).toBe(30);
  });

  test("instância de Date", () => {
    const date = new Date("2024-01-15T13:00:00.000Z");
    const zdt = parseZonedDateTime(date)!;
    expect(zdt.epochMilliseconds).toBe(date.getTime());
    expect(zdt.timeZoneId).toBe(SYSTEM_TZ);
  });

  test("epoch em milissegundos", () => {
    const zdt = parseZonedDateTime(1705323600000)!;
    expect(zdt.epochMilliseconds).toBe(1705323600000);
  });

  test("Temporal.Instant", () => {
    const instant = Temporal.Instant.from("2024-01-15T13:00:00Z");
    expect(parseZonedDateTime(instant)!.epochMilliseconds).toBe(instant.epochMilliseconds);
  });

  test("Temporal.PlainDateTime usa o time zone do sistema", () => {
    const zdt = parseZonedDateTime(Temporal.PlainDateTime.from("2024-01-15T10:00:00"))!;
    expect(zdt.timeZoneId).toBe(SYSTEM_TZ);
    expect(zdt.hour).toBe(10);
  });

  test("Temporal.PlainDate vira meia-noite no time zone do sistema", () => {
    const zdt = parseZonedDateTime(Temporal.PlainDate.from("2024-01-15"))!;
    expect(zdt.hour).toBe(0);
    expect(zdt.day).toBe(15);
  });

  test("objeto property bag com timeZone", () => {
    const zdt = parseZonedDateTime({
      year: 2024,
      month: 1,
      day: 15,
      timeZone: "America/Sao_Paulo",
    })!;
    expect(zdt.timeZoneId).toBe("America/Sao_Paulo");
  });

  test("valor inválido vira null", () => {
    expect(parseZonedDateTime("não-é-data")).toBeNull();
    expect(parseZonedDateTime(null)).toBeNull();
    expect(parseZonedDateTime(undefined)).toBeNull();
    expect(parseZonedDateTime("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Instant
// ---------------------------------------------------------------------------

describe("parseInstant", () => {
  test("string ISO com Z", () => {
    expect(parseInstant("2024-01-15T13:00:00Z")!.toString()).toBe("2024-01-15T13:00:00Z");
  });

  test("string com offset é normalizada para UTC", () => {
    expect(parseInstant("2024-01-15T10:00:00-03:00")!.toString()).toBe("2024-01-15T13:00:00Z");
  });

  test("ZonedDateTime vira o mesmo ponto no tempo", () => {
    const zdt = Temporal.ZonedDateTime.from("2024-01-15T10:00:00-03:00[America/Sao_Paulo]");
    expect(parseInstant(zdt)!.epochMilliseconds).toBe(zdt.epochMilliseconds);
  });

  test("instância de Date", () => {
    const date = new Date("2024-01-15T13:00:00.000Z");
    expect(parseInstant(date)!.epochMilliseconds).toBe(date.getTime());
  });

  test("epoch em segundos", () => {
    expect(parseInstant(1705323600)!.epochMilliseconds).toBe(1705323600000);
  });

  test("BR DD/MM/YYYY", () => {
    expect(parseInstant("15/01/2024")).toBeInstanceOf(Temporal.Instant);
  });

  test("inválido vira null", () => {
    expect(parseInstant("xyz")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Plain*
// ---------------------------------------------------------------------------

describe("parsePlainDate", () => {
  test("YYYY-MM-DD sem deslocamento de fuso", () => {
    expect(parsePlainDate("2024-01-15")!.toString()).toBe("2024-01-15");
  });

  test("string com time zone usa a data local da própria string", () => {
    expect(parsePlainDate("2024-01-15T23:00:00-03:00[America/Sao_Paulo]")!.toString()).toBe(
      "2024-01-15",
    );
  });

  test("BR DD/MM/YYYY", () => {
    expect(parsePlainDate("15/01/2024")!.toString()).toBe("2024-01-15");
  });

  test("instância de Date", () => {
    expect(parsePlainDate(new Date(2024, 0, 15, 12))!.toString()).toBe("2024-01-15");
  });

  test("ZonedDateTime", () => {
    const zdt = Temporal.ZonedDateTime.from("2024-01-15T10:00:00-03:00[America/Sao_Paulo]");
    expect(parsePlainDate(zdt)!.toString()).toBe("2024-01-15");
  });

  test("inválido vira null", () => {
    expect(parsePlainDate("xyz")).toBeNull();
  });
});

describe("parsePlainDateTime", () => {
  test("string ISO sem offset", () => {
    expect(parsePlainDateTime("2024-01-15T10:30:00")!.toString()).toBe("2024-01-15T10:30:00");
  });

  test("string com time zone mantém a hora local da string", () => {
    expect(parsePlainDateTime("2024-01-15T10:30:00-03:00[America/Sao_Paulo]")!.toString()).toBe(
      "2024-01-15T10:30:00",
    );
  });

  test("BR DD/MM/YYYY HH:mm:ss", () => {
    expect(parsePlainDateTime("15/01/2024 10:30:45")!.toString()).toBe("2024-01-15T10:30:45");
  });

  test("inválido vira null", () => {
    expect(parsePlainDateTime("xyz")).toBeNull();
  });
});

describe("parsePlainTime", () => {
  test("HH:mm", () => {
    expect(parsePlainTime("10:30")!.toString()).toBe("10:30:00");
  });

  test("HH:mm:ss", () => {
    expect(parsePlainTime("10:30:45")!.toString()).toBe("10:30:45");
  });

  test("extrai a hora de um datetime completo", () => {
    expect(parsePlainTime("2024-01-15T10:30:45-03:00[America/Sao_Paulo]")!.toString()).toBe(
      "10:30:45",
    );
  });

  test("string BR com hora", () => {
    expect(parsePlainTime("15/01/2024 10:30")!.toString()).toBe("10:30:00");
  });

  test("instância de Date", () => {
    expect(parsePlainTime(new Date(2024, 0, 15, 10, 30))!.toString()).toBe("10:30:00");
  });

  test("epoch como string numérica ainda devolve a hora", () => {
    expect(parsePlainTime("1705323600000")).toBeInstanceOf(Temporal.PlainTime);
  });

  test("string sem hora nenhuma vira null", () => {
    expect(parsePlainTime("2024-01-15")).toBeNull();
    expect(parsePlainTime("15/01/2024")).toBeNull();
  });

  test("inválido vira null", () => {
    expect(parsePlainTime("xyz")).toBeNull();
  });
});

describe("parsePlainYearMonth", () => {
  test("YYYY-MM", () => {
    expect(parsePlainYearMonth("2024-01")!.toString()).toBe("2024-01");
  });

  test("data completa vira o ano/mês", () => {
    expect(parsePlainYearMonth("2024-01-15")!.toString()).toBe("2024-01");
  });

  test("BR DD/MM/YYYY", () => {
    expect(parsePlainYearMonth("15/01/2024")!.toString()).toBe("2024-01");
  });

  test("inválido vira null", () => {
    expect(parsePlainYearMonth("xyz")).toBeNull();
  });
});

describe("parsePlainMonthDay", () => {
  test("--MM-DD", () => {
    expect(parsePlainMonthDay("--01-15")!.toString()).toBe("01-15");
  });

  test("MM-DD", () => {
    expect(parsePlainMonthDay("01-15")!.toString()).toBe("01-15");
  });

  test("BR DD/MM/YYYY", () => {
    expect(parsePlainMonthDay("15/01/2024")!.toString()).toBe("01-15");
  });

  test("inválido vira null", () => {
    expect(parsePlainMonthDay("xyz")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

describe("parseDuration", () => {
  test("string ISO 8601", () => {
    expect(parseDuration("PT1H30M")!.toString()).toBe("PT1H30M");
  });

  test("property bag", () => {
    expect(parseDuration({ hours: 1, minutes: 30 })!.toString()).toBe("PT1H30M");
  });

  test("número é interpretado como milissegundos", () => {
    expect(parseDuration(5400000)!.total("hour")).toBe(1.5);
  });

  test("instância de Duration é preservada", () => {
    const duration = Temporal.Duration.from("PT1H");
    expect(parseDuration(duration)).toBe(duration);
  });

  test("inválido vira null", () => {
    expect(parseDuration("xyz")).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Metadados de tipo
// ---------------------------------------------------------------------------

describe("temporalTypeName / isTemporalConstructor", () => {
  test("reconhece os construtores do Temporal", () => {
    expect(isTemporalConstructor(Temporal.ZonedDateTime)).toBe(true);
    expect(isTemporalConstructor(Temporal.PlainDate)).toBe(true);
    expect(isTemporalConstructor(Temporal.Duration)).toBe(true);
    expect(isTemporalConstructor(Date)).toBe(false);
    expect(isTemporalConstructor(class Foo {})).toBe(false);
  });

  test("devolve o nome do tipo declarável no @Field", () => {
    expect(temporalTypeName(Temporal.ZonedDateTime)).toBe("zoneddatetime");
    expect(temporalTypeName(Temporal.PlainMonthDay)).toBe("plainmonthday");
    expect(temporalTypeName(Date)).toBeUndefined();
  });
});

describe("consistência entre nome, construtor e conversor", () => {
  const ALL_CONSTRUCTORS = [
    Temporal.Instant,
    Temporal.ZonedDateTime,
    Temporal.PlainDate,
    Temporal.PlainDateTime,
    Temporal.PlainTime,
    Temporal.PlainYearMonth,
    Temporal.PlainMonthDay,
    Temporal.Duration,
  ];

  test("todo construtor do Temporal tem nome e conversor", () => {
    for (const ctor of ALL_CONSTRUCTORS) {
      const name = temporalTypeName(ctor);
      expect(name).toBeDefined();
      expect(getTemporalConverter(name)).toBeDefined();
      expect(getTemporalConverter(`Temporal.${ctor.name}`)).toBeDefined();
    }
  });

  test("tipo que não é do Temporal não tem conversor", () => {
    expect(getTemporalConverter("string")).toBeUndefined();
    expect(getTemporalConverter("date")).toBeUndefined();
    expect(getTemporalConverter(undefined)).toBeUndefined();
  });
});

describe("isDateLikeFieldType", () => {
  test("tipos de data", () => {
    expect(isDateLikeFieldType("date")).toBe(true);
    expect(isDateLikeFieldType("Date")).toBe(true);
    expect(isDateLikeFieldType("zoneddatetime")).toBe(true);
    expect(isDateLikeFieldType("Temporal.Instant")).toBe(true);
    expect(isDateLikeFieldType("plaindate")).toBe(true);
    expect(isDateLikeFieldType("plaindatetime")).toBe(true);
  });

  test("tipos que não representam um dia no calendário", () => {
    expect(isDateLikeFieldType("plaintime")).toBe(false);
    expect(isDateLikeFieldType("duration")).toBe(false);
    expect(isDateLikeFieldType("string")).toBe(false);
    expect(isDateLikeFieldType(undefined)).toBe(false);
  });
});

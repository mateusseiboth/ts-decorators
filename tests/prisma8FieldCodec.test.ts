import { beforeEach, describe, expect, test } from "bun:test";

import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import { buildPredicate } from "../src/prisma8/where";
import { fakeCombinators, fakeDb8, fakeProxy } from "../src/testing/prisma8Fakes";

/**
 * O codec da coluna mudou de lugar no proxy de campo do Prisma 8: até a 8.0.0-rc.17 ele vinha
 * em `field.codec`; na rc.18 foi para `field.returnType.codec`, ao lado de `codecId` e
 * `nullable`. Lendo só o lugar antigo, o filtro mandava `Date` para coluna `Temporal`
 * (`RUNTIME.ENCODE_FAILED`) e o rótulo do enum em vez do valor gravado, e aí a listagem
 * voltava vazia sem erro nenhum. As duas formas precisam funcionar enquanto houver projeto
 * nas duas versões.
 */

const ISO = "2026-07-13T12:04:46.218Z";
const enums = { tipoTributacao: { TRIBUTADO: "01", ISENTO: "03" } };

const TIMESTAMP = { codecId: "pg/timestamp-temporal@1", typeParams: { precision: 3 } };
const INT8 = { codecId: "pg/int8@1" };
const ENUM = { codecId: "pg/enum@1", typeParams: { typeName: "tipoTributacao" } };

type Spec = { codecId: string; typeParams?: Record<string, unknown> };
type Shape = (field: Record<string, unknown>, spec: Spec) => void;

const SHAPES: Record<string, Shape> = {
  "rc.17 (field.codec)": (field, spec) => {
    field.codec = spec;
  },
  "rc.18 (field.returnType.codec)": (field, spec) => {
    field.returnType = { codecId: spec.codecId, nullable: true, codec: spec };
  },
};

function proxyWith(shape: Shape) {
  const proxy = fakeProxy(
    { ImovelUrbano: { fields: ["id", "createdAt", "sequencial", "tipoTributacao"] } },
    "ImovelUrbano",
  );
  shape(proxy.createdAt, TIMESTAMP);
  shape(proxy.sequencial, INT8);
  shape(proxy.tipoTributacao, ENUM);
  return proxy;
}

type Leaf = { op: string; value: unknown };
type Branch = { op: string; args: Leaf[]; arg: Leaf };

for (const [nome, shape] of Object.entries(SHAPES)) {
  describe(`where lê o codec do proxy na forma da ${nome}`, () => {
    beforeEach(() => {
      resetPrisma8();
      configurePrisma8({ db: fakeDb8(), ...fakeCombinators, enums });
    });

    test("Date e ISO viram Temporal em equals, gt, gte, lt e lte", () => {
      const proxy = proxyWith(shape);
      const igual = buildPredicate(proxy, { createdAt: new Date(ISO) }) as Leaf;
      expect(igual.value).toBeInstanceOf(Temporal.PlainDateTime);

      const faixa = buildPredicate(proxy, {
        createdAt: { gt: ISO, gte: new Date(ISO), lt: ISO, lte: new Date(ISO), equals: ISO },
      }) as Branch;
      expect(faixa.args.map((leaf) => leaf.op)).toEqual(["gt", "gte", "lt", "lte", "eq"]);
      for (const leaf of faixa.args) expect(leaf.value).toBeInstanceOf(Temporal.PlainDateTime);
    });

    test("período (gte + lte, o between da query string) chega como Temporal", () => {
      const periodo = buildPredicate(proxyWith(shape), {
        createdAt: { gte: "2026-01-01T00:00:00.000Z", lte: "2026-12-31T23:59:59.999Z" },
      }) as Branch;
      expect((periodo.args[0].value as Temporal.PlainDateTime).toString()).toBe(
        "2026-01-01T00:00:00",
      );
      expect((periodo.args[1].value as Temporal.PlainDateTime).toString()).toBe(
        "2026-12-31T23:59:59.999",
      );
    });

    test("in, notIn e not convertem cada valor", () => {
      const proxy = proxyWith(shape);
      const lista = buildPredicate(proxy, { createdAt: { in: [ISO, new Date(ISO)] } }) as {
        value: unknown[];
      };
      for (const item of lista.value) expect(item).toBeInstanceOf(Temporal.PlainDateTime);

      const fora = buildPredicate(proxy, { sequencial: { notIn: [1, "2"] } }) as Leaf;
      expect(fora.value).toEqual([1n, 2n]);

      const diferente = buildPredicate(proxy, { sequencial: { not: 7 } }) as Leaf;
      expect(diferente).toEqual({ op: "neq", field: "sequencial", value: 7n });
    });

    test("number e string numérica viram bigint em coluna int8", () => {
      const proxy = proxyWith(shape);
      expect(buildPredicate(proxy, { sequencial: 728 })).toEqual({
        op: "eq",
        field: "sequencial",
        value: 728n,
      });
      const faixa = buildPredicate(proxy, { sequencial: { gte: 10, lte: "20" } }) as Branch;
      expect(faixa.args.map((leaf) => leaf.value)).toEqual([10n, 20n]);
    });

    test("rótulo do enum vira o valor gravado", () => {
      const proxy = proxyWith(shape);
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
      expect(buildPredicate(proxy, { tipoTributacao: { not: "ISENTO" } })).toEqual({
        op: "neq",
        field: "tipoTributacao",
        value: "03",
      });
    });
  });
}

describe("rc.18 sem codec ligado à coluna: vale o codecId do returnType", () => {
  beforeEach(() => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators, enums });
  });

  test("Date vira Temporal e number vira bigint pelo returnType.codecId", () => {
    const proxy = fakeProxy({ Bem: { fields: ["createdAt", "sequencial"] } }, "Bem");
    proxy.createdAt.returnType = { codecId: "pg/timestamptz-temporal@1", nullable: false };
    proxy.sequencial.returnType = { codecId: "pg/int8@1", nullable: true };
    const predicate = buildPredicate(proxy, {
      createdAt: { gte: new Date(ISO) },
      sequencial: 5,
    }) as Branch;
    expect(predicate.args[0].value).toBeInstanceOf(Temporal.Instant);
    expect(predicate.args[1].value).toBe(5n);
  });

  test("campo sem codec em lugar nenhum deixa o valor como veio", () => {
    const proxy = fakeProxy({ Bem: { fields: ["name"] } }, "Bem");
    expect(buildPredicate(proxy, { name: "x" })).toEqual({ op: "eq", field: "name", value: "x" });
  });
});

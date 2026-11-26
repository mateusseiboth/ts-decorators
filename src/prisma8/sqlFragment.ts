/**
 * Trechos de SQL cru com os parâmetros deles: o `Prisma.sql`, o `Prisma.join` e o `Prisma.empty`
 * do Prisma 7, para o `db.raw.sql` do Prisma 8.
 *
 * O `db.raw.sql` só interpola VALOR. Para montar um comando em pedaços (um filtro opcional, uma
 * lista de condições), o trecho interpolado precisa virar texto do comando, e os valores dele,
 * parâmetros na mesma ordem. É o que `sql` faz:
 *
 * ```ts
 * const nomes = joinSql([sql`nome = ${"Natal"}`, sql`nome = ${"Páscoa"}`], " OR ");
 * const filtro = sql`entidade = ${10} AND (${nomes})`;
 * const plano = db.raw.sql(...toTemplate(sql`SELECT id FROM feriados WHERE ${filtro}`))
 *   .returnsRow({ id: "pg/text@1" })
 *   .build();
 * ```
 *
 * O texto do trecho nunca vem da requisição: valor de fora entra sempre como `${valor}`.
 */
import { getPrisma8 } from "./client";

/** O codec da data interpolada: `timestamptz`, como o `$queryRaw` do Prisma 7 mandava. */
const CODEC_DA_DATA = "pg/timestamptz-date@1";

/** Trecho de SQL cru: o texto em pedaços e os valores entre eles. */
export class SqlFragment {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}
}

/** O trecho vazio, para a parte opcional ausente: `${hasFiltro ? filtro : EMPTY_SQL}`. */
export const EMPTY_SQL = new SqlFragment([""], []);

/** Junta `fragment` ao fim de `strings`/`values`, emendando o texto das pontas. */
function appendFragment(strings: string[], values: unknown[], fragment: SqlFragment): void {
  strings[strings.length - 1] += fragment.strings[0] ?? "";
  fragment.values.forEach((value, index) => {
    values.push(value);
    strings.push(fragment.strings[index + 1] ?? "");
  });
}

const asFragment = (value: unknown): SqlFragment =>
  value instanceof SqlFragment ? value : new SqlFragment(["", ""], [value]);

/** Template tag: o valor interpolado vira parâmetro, e o trecho interpolado, parte do texto. */
export function sql(strings: readonly string[], ...values: unknown[]): SqlFragment {
  const texto = [strings[0] ?? ""];
  const valores: unknown[] = [];
  values.forEach((value, index) => {
    appendFragment(texto, valores, asFragment(value));
    texto[texto.length - 1] += strings[index + 1] ?? "";
  });
  return new SqlFragment(texto, valores);
}

/** Os trechos com `separator` entre eles. O separador é texto, nunca parâmetro. */
export function joinSql(fragments: readonly SqlFragment[], separator: string): SqlFragment {
  const texto = [""];
  const valores: unknown[] = [];
  fragments.forEach((fragment, index) => {
    texto[texto.length - 1] += index > 0 ? separator : "";
    appendFragment(texto, valores, fragment);
  });
  return new SqlFragment(texto, valores);
}

/**
 * A data vira parâmetro com o codec explícito: o Prisma 8 não infere o de `Date`. O `param` vem
 * do `configurePrisma8`, porque o pacote não importa o Prisma 8.
 */
function encodeValue(value: unknown): unknown {
  if (!(value instanceof Date)) return value;
  const { param } = getPrisma8();
  if (!param) {
    throw new Error(
      "[@mateusseiboth/ts-decorators] Data no SQL cru precisa do `param` no configurePrisma8 (de @prisma/orm-family-sql/relational-core).",
    );
  }
  return param(value, { codecId: CODEC_DA_DATA });
}

/** O trecho como os argumentos do `db.raw.sql`: `db.raw.sql(...toTemplate(trecho))`. */
export function toTemplate(fragment: SqlFragment): [TemplateStringsArray, ...unknown[]] {
  const strings = Object.assign([...fragment.strings], {
    raw: [...fragment.strings],
  }) as unknown as TemplateStringsArray;
  return [strings, ...fragment.values.map(encodeValue)];
}

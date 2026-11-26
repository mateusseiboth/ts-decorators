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

/**
 * O valor que o `raw.sql` do Prisma 8 aceita cru (`RawSqlLiteral` de
 * `@prisma/orm-family-sql/relational-core`). Data vai como o `ParamRef` do `param`, que o
 * `raw.sql` também aceita.
 */
export type RawSqlValue = number | bigint | string | boolean | Uint8Array;

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

/** `NULL` no texto: a interpolação crua do Prisma 8 não aceita `null` como parâmetro. */
const SQL_NULL = new SqlFragment(["NULL"], []);

/** O fragmento de cada interpolação: trecho como texto, `null` como `NULL`, o resto parâmetro. */
const asFragment = (value: unknown): SqlFragment => {
  if (value instanceof SqlFragment) return value;
  if (value === null) return SQL_NULL;
  if (value === undefined) {
    throw new TypeError(
      "[@mateusseiboth/ts-decorators] Valor undefined no SQL cru. Use null (vira NULL) ou EMPTY_SQL.",
    );
  }
  return new SqlFragment(["", ""], [value]);
};

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

/**
 * O trecho como os argumentos do `db.raw.sql`, já no tipo que ele aceita:
 * `db.raw.sql(...toTemplate(trecho))`, sem cast. `I` troca o tipo da interpolação quando o projeto
 * quer o `RawSqlInterpolation` do próprio Prisma: `toTemplate<RawSqlInterpolation>(trecho)`.
 */
export function toTemplate<I = RawSqlValue>(fragment: SqlFragment): [TemplateStringsArray, ...I[]] {
  const strings = Object.assign([...fragment.strings], {
    raw: [...fragment.strings],
  }) as unknown as TemplateStringsArray;
  return [strings, ...(fragment.values.map(encodeValue) as I[])];
}

/** Nome de tipo do Postgres: `uuid`, `text`, `timestamp with time zone`, `int4[]`... */
const NOME_DE_TIPO = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*(\[\])?$/;

/**
 * Valor opcional com tipo: `null` vira `CAST(NULL AS tipo)` e o valor vira `CAST($n AS tipo)`. Para
 * a coluna em que o `NULL` sem tipo não resolve (`COALESCE`, `CASE`, função sobrecarregada).
 */
export function sqlNullable(value: unknown, type: string): SqlFragment {
  if (!NOME_DE_TIPO.test(type)) {
    throw new TypeError(
      `[@mateusseiboth/ts-decorators] sqlNullable: "${type}" não é um nome de tipo.`,
    );
  }
  return sql`CAST(${value ?? null} AS ${new SqlFragment([type], [])})`;
}

/**
 * Ponto de contato do pacote com o Prisma 8 (`@prisma/orm-postgres`).
 *
 * O pacote não importa o Prisma 8: é distribuído em fonte e roda em projeto que ainda está
 * no Prisma 7. Quem usa o 8 registra UMA vez, no bootstrap, a fachada (`db`) e os
 * combinadores de predicado (`and`/`or`/`not` de `@prisma/orm-postgres/orm-client`):
 *
 * ```ts
 * import { and, not, or } from "@prisma/orm-postgres/orm-client";
 * import { configurePrisma8 } from "@mateusseiboth/ts-decorators";
 * import { db } from "@database/db";
 *
 * configurePrisma8({ db, and, or, not });
 * ```
 *
 * Tudo aqui é duck-typing: transação do 7 tem `$executeRawUnsafe`; a do 8 tem
 * `execute`/`query`/`orm`.
 */

/**
 * `any` de propósito: os tipos reais (`AnyExpression`, `RawSqlInterpolation`, o spec de codec
 * por coluna) vivem no pacote do Prisma 8, que este pacote não importa. O contrato aqui é pela
 * FORMA; a tipagem forte fica no projeto, que chama a fachada direto.
 */
export type Combinator = (...expressions: any[]) => any;

/** Rótulo do membro → valor gravado no banco, por enum (`{ tipoTributacao: { ISENTO: "03" } }`). */
export type EnumLabels = Record<string, Record<string, string>>;

export interface Prisma8Config {
  /** Fachada `postgres<Contract>(...)`: só `db.raw.sql` é usado aqui. */
  db: { raw: { sql: (strings: TemplateStringsArray, ...values: any[]) => RawBuilder } };
  and: Combinator;
  or: Combinator;
  not: (expression: any) => any;
  /**
   * O ORM do Prisma 8 lê e escreve o VALOR do enum no banco (`"03"`), e o contrato emitido
   * descarta o rótulo (`ISENTO`). Registrado aqui, o mapa faz a fronteira traduzir: rótulo vira
   * valor na escrita e no filtro, valor vira rótulo na leitura — o mesmo contrato do Prisma 7.
   */
  enums?: EnumLabels;
  /**
   * O Prisma 8 decodifica `numeric` como STRING decimal (`"412.6600"`) — não há codec que devolva
   * número. Com `true`, a leitura (`readRows`/`decodeRowsForCollection`, logo toda leitura de DAO
   * e toda listagem) devolve `number`: quem guarda dinheiro e quantidade em `numeric` continua
   * fazendo conta, e `a + b` não vira concatenação. Opt-in: sem ele, o texto segue como veio.
   */
  numericAsNumber?: boolean;
  /**
   * Classes do AST do Prisma 8 (`@prisma/orm-postgres/relational-core/ast`), que o pacote não
   * importa. Com elas o `applyOrderBy` ordena por campo de RELAÇÃO to-one
   * (`{ contribuinte: { name: "asc" } }`): a coluna vira uma subconsulta correlacionada no
   * `ORDER BY`. Sem elas, ordenar por relação falha alto.
   */
  ast?: Prisma8Ast;
}

/** O pedaço do AST do Prisma 8 que a ordenação por relação usa. */
export interface Prisma8Ast {
  SubqueryExpr: { of(query: any): any };
  ProjectionItem: { of(alias: string, expr: any): any };
}

interface RawBuilder {
  affectedCount(): { build(): any };
  returnsRow(spec: any): { build(): any };
}

/** Transação do Prisma 8 (`db.transaction(async (tx) => ...)`), no que o pacote usa dela. */
export interface Prisma8Tx {
  orm: Record<string, unknown>;
  execute(plan: unknown): Promise<{ affectedRows: number }>;
  query(plan: unknown): Promise<unknown> | AsyncIterable<unknown>;
}

let _config: Prisma8Config | null = null;
/** A configuração do BOOTSTRAP, que `resetPrisma8()` restaura depois de um teste trocar por fake. */
let _base: Prisma8Config | null = null;

export interface ConfigurePrisma8Options {
  /**
   * `true` no bootstrap da aplicação: marca esta configuração como a de referência. Um teste
   * que chama `configurePrisma8(fake)` e depois `resetPrisma8()` volta para ela, em vez de
   * deixar o fake vazar para os arquivos de teste seguintes.
   */
  base?: boolean;
}

export function configurePrisma8(
  config: Prisma8Config,
  options: ConfigurePrisma8Options = {},
): void {
  _config = config;
  if (options.base) _base = config;
}

/** Volta para a configuração de bootstrap (ou para "não configurado", se não houver). */
export function resetPrisma8(): void {
  _config = _base;
}

/** Esquece TUDO, inclusive o bootstrap — só para testar o próprio "não configurado". */
export function clearPrisma8(): void {
  _config = null;
  _base = null;
}

/** Mapa de enums registrado, ou vazio (sem `configurePrisma8`, nada é traduzido). */
export function getEnumLabels(): EnumLabels {
  return _config?.enums ?? {};
}

/** `numeric` volta como `number` na leitura? (`numericAsNumber` do `configurePrisma8`). */
export function isNumericAsNumber(): boolean {
  return _config?.numericAsNumber === true;
}

/** As classes do AST registradas, ou `undefined` quando o bootstrap não as passou. */
export function getPrisma8Ast(): Prisma8Ast | undefined {
  return _config?.ast;
}

export function getPrisma8(): Prisma8Config {
  if (!_config) {
    throw new Error(
      "[@mateusseiboth/ts-decorators] Prisma 8 não configurado. Chame configurePrisma8({ db, and, or, not }) no bootstrap.",
    );
  }
  return _config;
}

export function isPrisma7Tx(tx: unknown): boolean {
  return (
    typeof (tx as { $executeRawUnsafe?: unknown } | undefined)?.$executeRawUnsafe === "function"
  );
}

export function isPrisma8Tx(tx: unknown): tx is Prisma8Tx {
  const candidate = tx as Partial<Prisma8Tx> | undefined;
  return (
    typeof candidate?.execute === "function" &&
    typeof candidate?.query === "function" &&
    !!candidate?.orm
  );
}

/** Um SQL fixo (sem parâmetros) como template literal, para o tag `db.raw.sql`. */
function asTemplate(sql: string): TemplateStringsArray {
  return Object.assign([sql], { raw: [sql] }) as unknown as TemplateStringsArray;
}

/** Plano cru sem retorno de linhas (`SET LOCAL`, `SAVEPOINT`, DDL...). */
export function rawStatementPlan(sql: string): unknown {
  return getPrisma8().db.raw.sql(asTemplate(sql)).affectedCount().build();
}

/**
 * Plano cru sem retorno de linhas COM parâmetros: cada valor interpolado vai ao banco como
 * parâmetro (`$1`, `$2`...), nunca colado no texto do SQL.
 *
 * ```ts
 * await tx.execute(rawParamStatementPlan`SELECT set_config('app.tenant', ${id}, true)`);
 * ```
 */
export function rawParamStatementPlan(
  strings: TemplateStringsArray,
  ...values: unknown[]
): unknown {
  return getPrisma8()
    .db.raw.sql(strings, ...values)
    .affectedCount()
    .build();
}

/** Plano cru que devolve linhas; `spec` declara o codec de cada coluna (`"pg/text@1"`...). */
export function rawRowsPlan(sql: string, spec: Record<string, string>): unknown {
  return getPrisma8().db.raw.sql(asTemplate(sql)).returnsRow(spec).build();
}

type StatementRunner = (tx: unknown, sql: string) => Promise<unknown>;

const STATEMENT_RUNNERS: Array<[(tx: unknown) => boolean, StatementRunner]> = [
  [
    isPrisma7Tx,
    (tx, sql) => (tx as { $executeRawUnsafe(s: string): Promise<unknown> }).$executeRawUnsafe(sql),
  ],
  [isPrisma8Tx, (tx, sql) => (tx as Prisma8Tx).execute(rawStatementPlan(sql))],
];

/**
 * Executa um statement SEM parâmetros na transação, seja ela do Prisma 7 ou do 8.
 * Falha alto para qualquer outro objeto: rodar fora de transação perderia o `SET LOCAL`.
 */
export async function runStatement(tx: unknown, sql: string): Promise<unknown> {
  const runner = STATEMENT_RUNNERS.find(([matches]) => matches(tx))?.[1];
  if (!runner)
    throw new Error(
      "[@mateusseiboth/ts-decorators] Objeto não é uma transação do Prisma 7 nem do Prisma 8.",
    );
  return runner(tx, sql);
}

/** Coleção do model na transação do Prisma 8 (`tx.orm.public.Bairro`), ou `undefined`. */
export function ormCollection(tx: Prisma8Tx, modelName: string): unknown {
  const orm = tx.orm as Record<string, unknown>;
  const namespace = (orm.public as Record<string, unknown> | undefined) ?? orm;
  return namespace[modelName] ?? namespace[modelName.charAt(0).toLowerCase() + modelName.slice(1)];
}

/**
 * Fakes que imitam a superfície do Prisma 8 (`@prisma/orm-postgres`) usada pelo pacote:
 * coleção encadeável, proxy de campo com operadores e combinadores `and`/`or`/`not`.
 *
 * Cada operador devolve uma ÁRVORE serializável (`{ op, field, value }`), para que os testes
 * comparem a tradução com `toEqual` sem depender de SQL.
 */

import { PARTIAL_CONTRACT } from "../fields/rowFields";

export interface FakeModelMeta {
  fields: string[];
  relations?: Record<string, string>; // nome da relação → model alvo
  /**
   * Colunas cujo acessor nasce SEM `asc`/`desc` — no Prisma 8 é o caso de toda coluna
   * `Boolean`, porque o codec `bool` não declara o trait `order`. Elas contam como campo do
   * model (entram em `fields` sozinhas), mas o proxy não as deixa ordenar diretamente.
   */
  withoutOrdenacao?: string[];
  /** @deprecated Use `withoutOrdenacao`. Continua aceito até a 3.0. */
  semOrdenacao?: string[];
  /**
   * Colunas NOT NULL. Com a lista, toda coluna do model sai no contrato com `nullable` (`false`
   * nestas, `true` nas outras), como no contrato emitido. Sem ela, o contrato não diz.
   */
  required?: string[];
  /** Model discriminado: valor do discriminador → model da variante (`{ ALUNO: "VinculoDeAluno" }`). */
  variants?: Record<string, string>;
  /** Variante: o model base (`@@base`). Sem `table`, a variante mora na tabela da base. */
  base?: string;
  /** Tabela do model. Default: o nome do model (a variante, a tabela da base). */
  table?: string;
}

export type FakeContractModels = Record<string, FakeModelMeta>;

/** As colunas que o ORM se recusa a ordenar (`withoutOrdenacao`, ou o legado `semOrdenacao`). */
const unorderableFields = (meta: FakeModelMeta): string[] =>
  meta.withoutOrdenacao ?? meta.semOrdenacao ?? [];

/** Todas as colunas do model: as ordenáveis e as que o ORM se recusa a ordenar. */
const allFields = (meta: FakeModelMeta): string[] => [...meta.fields, ...unorderableFields(meta)];

/** A coluna como o contrato a declara; `nullable` só quando o model diz quais são obrigatórias. */
const buildField = (meta: FakeModelMeta, field: string) => ({
  type: { kind: "scalar" },
  ...(meta.required ? { nullable: !meta.required.includes(field) } : {}),
});

/** A tabela do model: a declarada, a da base (variante) ou o nome do model. */
const tableOf = (models: FakeContractModels, name: string): string => {
  const meta = models[name];
  return meta?.table ?? (meta?.base ? tableOf(models, meta.base) : name);
};

export function fakeContract(models: FakeContractModels) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, meta] of Object.entries(models)) {
    out[name] = {
      fields: Object.fromEntries(allFields(meta).map((f) => [f, buildField(meta, f)])),
      relations: Object.fromEntries(
        Object.entries(meta.relations ?? {}).map(([rel, to]) => [
          rel,
          { cardinality: "1:N", to: { model: to, namespace: "public" } },
        ]),
      ),
      storage: {
        table: tableOf(models, name),
        namespaceId: "public",
        fields: Object.fromEntries(allFields(meta).map((f) => [f, { column: f }])),
      },
      ...(meta.variants
        ? {
            variants: Object.fromEntries(
              Object.entries(meta.variants).map(([valor, model]) => [
                valor,
                { model, namespace: "public" },
              ]),
            ),
          }
        : {}),
      ...(meta.base ? { base: { model: meta.base, namespace: "public" } } : {}),
    };
  }
  // O contrato do fake só declara os models do teste: a conferência das classes cifradas (que
  // exige TODOS os models do schema) não roda nele.
  return Object.defineProperty(
    { domain: { namespaces: { public: { models: out } } } },
    PARTIAL_CONTRACT,
    {
      value: true,
    },
  );
}

export const fakeCombinators = {
  and: (...args: unknown[]) => ({ op: "and", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  not: (arg: unknown) => ({ op: "not", arg }),
};

const SCALAR_OPS = [
  "eq",
  "neq",
  "in",
  "notIn",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "isNull",
  "isNotNull",
];

/**
 * O item de ordenação do Prisma 8 é INSTÂNCIA de uma classe com fábricas estáticas
 * (`OrderByItem.asc(expr)`), e é assim que a coluna sem `asc` consegue ser ordenada: pegando a
 * classe emprestada de um campo irmão. O fake precisa ter a mesma forma, senão o teste passaria
 * por um caminho que não existe no ORM real.
 */
class FakeOrderByItem {
  constructor(
    readonly order: "asc" | "desc",
    readonly field: unknown,
  ) {}

  static asc(field: unknown): FakeOrderByItem {
    return new FakeOrderByItem("asc", field);
  }

  static desc(field: unknown): FakeOrderByItem {
    return new FakeOrderByItem("desc", field);
  }
}

/** O `SelectAst` da subconsulta da relação, no que a ordenação usa dele. */
function fakeSubquery(rel: string) {
  return { withProjection: (projection: unknown[]) => ({ rel, projection }) };
}

/** As classes do AST do Prisma 8 (`configurePrisma8({ ..., ast })`), na forma do fake. */
export const fakeAst = {
  SubqueryExpr: { of: (query: unknown) => ({ subquery: query }) },
  ProjectionItem: { of: (alias: string, expr: unknown) => ({ alias, expr }) },
};

export function fakeProxy(models: FakeContractModels, model: string): any {
  const meta = models[model];
  if (!meta) throw new Error(`fake: model ${model} não existe`);
  const target: Record<string, unknown> = {};
  for (const field of allFields(meta)) {
    const ops: Record<string, unknown> = {};
    for (const op of SCALAR_OPS) {
      ops[op] = (value?: unknown) => (value === undefined ? { op, field } : { op, field, value });
    }
    // `buildAst` existe em TODA coluna — é por ele que dá para ordenar a que não tem `asc`.
    ops.buildAst = () => field;
    if (!unorderableFields(meta).includes(field)) {
      ops.asc = () => FakeOrderByItem.asc(field);
      ops.desc = () => FakeOrderByItem.desc(field);
    }
    target[field] = ops;
  }
  for (const [rel, to] of Object.entries(meta.relations ?? {})) {
    const relOp = (op: string) => (predicate?: (p: unknown) => unknown) =>
      // A subconsulta do `EXISTS` (`ExistsExpr.subquery` no ORM) fica fora da comparação: é o
      // que a ordenação por relação reaproveita, trocando a projeção.
      Object.defineProperty(
        { op, rel, pred: predicate ? predicate(fakeProxy(models, to)) : undefined },
        "subquery",
        { value: fakeSubquery(rel), enumerable: false },
      );
    target[rel] = { some: relOp("some"), every: relOp("every"), none: relOp("none") };
  }
  return target;
}

export interface FakeState {
  where: unknown[];
  select?: string[];
  include: Array<{ rel: string; branch: FakeState }>;
  orderBy?: unknown[];
  limit?: number;
  offset?: number;
  distinctOn?: string[];
  distinct?: boolean;
  groupBy?: string[];
}

export interface FakeResults {
  /** Linhas devolvidas por `all()`; pode ser função para variar por chamada. */
  rows?: unknown[] | ((state: FakeState, call: number) => unknown[]);
  count?: number;
  /** O que `updateAndCount`/`deleteAndCount` devolvem (default: `count`, senão 0). */
  afetadas?: number;
  /** Linhas que `groupBy(...).aggregate(...)` devolve (chaves do grupo + agregados). */
  grupos?: unknown[];
  /** O que `aggregate(...)` devolve para `sum`/`avg`/`min`/`max`, pelo nome do resultado. */
  agregados?: Record<string, unknown>;
}

/** O que cada operação do `aggregate` do fake registra: a função e a coluna. */
export interface FakeAggregateOp {
  fn: "count" | "sum" | "avg" | "min" | "max";
  field?: string;
}

/** O construtor de agregados que o `aggregate(fn)` real entrega ao callback. */
export interface FakeAggregateBuilder {
  count(): FakeAggregateOp;
  sum(field: string): FakeAggregateOp;
  avg(field: string): FakeAggregateOp;
  min(field: string): FakeAggregateOp;
  max(field: string): FakeAggregateOp;
}

const FAKE_AGGREGATE_BUILDER: FakeAggregateBuilder = {
  count: () => ({ fn: "count" }),
  sum: (field) => ({ fn: "sum", field }),
  avg: (field) => ({ fn: "avg", field }),
  min: (field) => ({ fn: "min", field }),
  max: (field) => ({ fn: "max", field }),
};

/** Uma ESCRITA registrada em `calls`, com o payload e (no upsert) a restrição de conflito. */
/** Terminais de escrita que passam pelo gancho (o `upsert` passa o `create`). */
export type FakeWriteTerminal = "create" | "createAll" | "upsert" | "update" | "updateAndCount";

/**
 * Gancho aplicado a CADA linha antes de um terminal de escrita registrá-la. Existe para o
 * projeto reproduzir no fake o que um middleware do runtime faz na escrita real (auditoria:
 * `createdBy`, `entidade`, `updatedAt`...), senão o teste do DAO confere um payload que nunca
 * chega assim ao banco. `fields` são as colunas declaradas no model fake.
 */
export type FakeWriteHook = (
  terminal: FakeWriteTerminal,
  modelName: string,
  fields: string[],
  data: Record<string, unknown>,
) => Record<string, unknown>;

let writeHook: FakeWriteHook | undefined;

/** Instala (ou remove, sem argumento) o gancho de escrita dos fakes. */
export function setFakeWriteHook(hook?: FakeWriteHook): void {
  writeHook = hook;
}

/** Aplica o gancho instalado; sem gancho, devolve a linha como veio. */
export function runFakeWriteHook(
  terminal: FakeWriteTerminal,
  modelName: string,
  fields: string[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  return writeHook ? writeHook(terminal, modelName, fields, data) : data;
}

export interface FakeWrite {
  terminal: string;
  state: FakeState;
  data?: unknown;
  conflictOn?: unknown;
}

/**
 * Coleção fake: cada método devolve uma NOVA coleção com o estado acumulado, como a real.
 * `calls` registra o estado de cada terminal (`all`/`first`/`count`) na ordem em que rodou.
 */
export class FakeCollection {
  readonly calls: Array<{
    terminal: string;
    state: FakeState;
    data?: unknown;
    conflictOn?: unknown;
  }>;
  readonly contract: unknown;
  readonly modelName: string;
  readonly namespaceId = "public";
  private readonly models: FakeContractModels;
  private readonly results: FakeResults;
  readonly state: FakeState;

  constructor(
    models: FakeContractModels,
    modelName: string,
    results: FakeResults = {},
    state?: FakeState,
    calls?: Array<{ terminal: string; state: FakeState; data?: unknown; conflictOn?: unknown }>,
  ) {
    this.models = models;
    this.modelName = modelName;
    this.results = results;
    this.contract = fakeContract(models);
    this.state = state ?? { where: [], include: [] };
    this.calls = calls ?? [];
  }

  private next(patch: Partial<FakeState>): FakeCollection {
    return new FakeCollection(
      this.models,
      this.modelName,
      this.results,
      { ...this.state, ...patch },
      this.calls,
    );
  }

  where(input: unknown): FakeCollection {
    const expr =
      typeof input === "function"
        ? input(fakeProxy(this.models, this.modelName))
        : { op: "eqObject", value: input };
    return this.next({ where: [...this.state.where, expr] });
  }

  select(...fields: string[]): FakeCollection {
    return this.next({ select: fields });
  }

  include(rel: string, refine?: (branch: FakeCollection) => FakeCollection): FakeCollection {
    const to = this.models[this.modelName]?.relations?.[rel];
    if (!to) throw new Error(`fake: relação ${this.modelName}.${rel} não existe`);
    const branch = new FakeCollection(this.models, to, this.results);
    const refined = refine ? refine(branch) : branch;
    return this.next({ include: [...this.state.include, { rel, branch: refined.state }] });
  }

  orderBy(input: unknown): FakeCollection {
    const lambdas = Array.isArray(input) ? input : [input];
    const proxy = fakeProxy(this.models, this.modelName);
    return this.next({ orderBy: lambdas.map((fn: (p: unknown) => unknown) => fn(proxy)) });
  }

  limit(n: number): FakeCollection {
    return this.next({ limit: n });
  }

  offset(n: number): FakeCollection {
    return this.next({ offset: n });
  }

  distinctOn(...fields: string[]): FakeCollection {
    return this.next({ distinctOn: fields });
  }

  distinct(): FakeCollection {
    return this.next({ distinct: true });
  }

  all(): Promise<unknown[]> & { first(): Promise<unknown> } {
    this.calls.push({ terminal: "all", state: this.state });
    const call = this.calls.filter((c) => c.terminal === "all").length;
    const rows =
      typeof this.results.rows === "function"
        ? this.results.rows(this.state, call)
        : (this.results.rows ?? []);
    const promise = Promise.resolve(rows) as Promise<unknown[]> & { first(): Promise<unknown> };
    promise.first = () => Promise.resolve(rows[0] ?? null);
    return promise;
  }

  async first(): Promise<unknown> {
    this.calls.push({ terminal: "first", state: this.state });
    const rows =
      typeof this.results.rows === "function"
        ? this.results.rows(this.state, 1)
        : (this.results.rows ?? []);
    return rows[0] ?? null;
  }

  private rowsNow(): unknown[] {
    const rows = this.results.rows;
    if (typeof rows === "function") return rows(this.state, 1);
    return rows ?? [];
  }

  /**
   * A linha que um terminal de escrita devolve: a primeira de `rows` mesclada com o payload, ou
   * `null` quando `rows` (lista ou função) não devolve linha para o filtro. Sem `rows`, o payload.
   */
  private writtenRow(data: Record<string, unknown>): Record<string, unknown> | null {
    const [primeira] = this.rowsNow();
    if (this.results.rows !== undefined && primeira === undefined) return null;
    return { ...((primeira as Record<string, unknown> | undefined) ?? {}), ...data };
  }

  // ── Escrita (o que `BaseDAO.insert`/`updateWhere`/`updateManyWhere` chamam) ──

  private hooked(terminal: FakeWriteTerminal, data: Record<string, unknown>) {
    return runFakeWriteHook(
      terminal,
      this.modelName,
      this.models[this.modelName]?.fields ?? [],
      data,
    );
  }

  async create(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = this.hooked("create", input);
    this.calls.push({ terminal: "create", state: this.state, data });
    return { ...((this.rowsNow()[0] as Record<string, unknown> | undefined) ?? {}), ...data };
  }

  async createAll(input: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const rows = input.map((row) => this.hooked("createAll", row));
    this.calls.push({ terminal: "createAll", state: this.state, data: rows });
    return rows.map((row) => ({ ...row }));
  }

  async upsert(input: {
    create: Record<string, unknown>;
    update: Record<string, unknown>;
    conflictOn?: unknown;
  }): Promise<Record<string, unknown>> {
    const create = this.hooked("upsert", input.create);
    this.calls.push({
      terminal: "upsert",
      state: this.state,
      data: create,
      conflictOn: input.conflictOn,
    });
    // A linha já existente vence o INSERT, como no `ON CONFLICT DO NOTHING` + releitura.
    return (this.rowsNow()[0] as Record<string, unknown> | undefined) ?? { ...create };
  }

  /** Como na coleção real: devolve UMA linha (a alterada) ou `null` quando nada casou. */
  async update(input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const data = this.hooked("update", input);
    this.calls.push({ terminal: "update", state: this.state, data });
    return this.writtenRow(data);
  }

  async updateAndCount(input: Record<string, unknown>): Promise<number> {
    const data = this.hooked("updateAndCount", input);
    this.calls.push({ terminal: "updateAndCount", state: this.state, data });
    return this.results.afetadas ?? this.results.count ?? 0;
  }

  async delete(): Promise<Record<string, unknown> | null> {
    this.calls.push({ terminal: "delete", state: this.state });
    return this.writtenRow({});
  }

  async deleteAndCount(): Promise<number> {
    this.calls.push({ terminal: "deleteAndCount", state: this.state });
    return this.results.afetadas ?? this.results.count ?? 0;
  }

  /** `groupBy(...).aggregate(...)` devolve um ARRAY (chaves do grupo + agregados). */
  groupBy(...fields: string[]): { aggregate(spec: unknown): Promise<unknown[]> } {
    return {
      aggregate: async () => {
        this.calls.push({ terminal: "groupBy", state: { ...this.state, groupBy: fields } });
        return this.results.grupos ?? [];
      },
    };
  }

  /** Só as escritas registradas, na ordem. */
  get writes(): FakeWrite[] {
    const terminais = new Set([
      "create",
      "createAll",
      "upsert",
      "update",
      "updateAndCount",
      "delete",
      "deleteAndCount",
    ]);
    return this.calls.filter((call) => terminais.has(call.terminal)) as FakeWrite[];
  }

  /**
   * Como na coleção real: `count()` só existe como reducer de include; o total vem por
   * `aggregate`. `count` responde `results.count` (0 sem ele); `sum`/`avg`/`min`/`max` respondem
   * `results.agregados[nome]`, ou `null`, que é o que o SQL devolve sobre zero linhas.
   */
  async aggregate(
    spec: (a: FakeAggregateBuilder) => Record<string, FakeAggregateOp>,
  ): Promise<Record<string, unknown>> {
    const shape = spec(FAKE_AGGREGATE_BUILDER);
    this.calls.push({ terminal: "aggregate", state: this.state, data: shape });
    const valueOf = (name: string, op: FakeAggregateOp) =>
      op.fn === "count" ? (this.results.count ?? 0) : (this.results.agregados?.[name] ?? null);
    return Object.fromEntries(Object.entries(shape).map(([name, op]) => [name, valueOf(name, op)]));
  }

  /** `with(fragmento)` do Prisma 8: aplica um pedaço de consulta reaproveitável à coleção. */
  with<R>(fragment: (collection: FakeCollection) => R): R {
    return fragment(this);
  }
}

/**
 * Transação fake do Prisma 8: `execute`/`query` recebem o PLANO cru e registram o SQL em
 * `statements` e o plano inteiro (com os valores parametrizados) em `plans`.
 */
export function fakeTx8(
  models: FakeContractModels,
  collections: Record<string, FakeCollection> = {},
) {
  const statements: string[] = [];
  const plans: unknown[] = [];
  return {
    statements,
    plans,
    orm: { public: collections },
    enums: { public: {} },
    nativeEnums: { public: {} },
    async execute(plan: { sql: string }) {
      statements.push(plan.sql);
      plans.push(plan);
      return { affectedRows: 0 };
    },
    async query(plan: { sql: string }) {
      statements.push(plan.sql);
      plans.push(plan);
      return [];
    },
  };
}

/** Fachada fake do Prisma 8: só o `raw.sql` que o pacote usa para montar statements. */
export function fakeDb8() {
  return {
    raw: {
      sql: (strings: TemplateStringsArray, ...interpolados: unknown[]) => {
        const sql = strings.raw.join("?");
        // Expressão interpolada (a coluna, no ORM real) entra pelo `buildAst`, como no `raw.sql`.
        const values = interpolados.map((valor) =>
          typeof (valor as { buildAst?: unknown })?.buildAst === "function"
            ? (valor as { buildAst(): unknown }).buildAst()
            : valor,
        );
        return {
          affectedCount: () => ({ build: () => ({ sql, values, kind: "execute" }) }),
          returnsRow: (spec: unknown) => ({ build: () => ({ sql, values, spec, kind: "query" }) }),
          // A expressão crua tipada; o `buildAst` fica fora da comparação dos testes.
          returns: (returns: unknown) =>
            Object.defineProperty({ sql, values, returns }, "buildAst", {
              value: () => ({ sql, values, returns }),
              enumerable: false,
            }),
        };
      },
    },
  };
}

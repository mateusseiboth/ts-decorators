/**
 * Campo de VARIANTE de model discriminado (`@@discriminator` + `@@base`) através de relação.
 *
 * A relação do contrato aponta para a base (`Mensalidade.aluno` → `Vinculo`), e a coluna pedida
 * (`nome`) é da variante (`VinculoDeAluno`, `@@base(Vinculo, "ALUNO")`). O acessor que o ORM
 * entrega dentro do `some(...)` da relação é o da BASE, sem os campos da variante: pedir
 * `relacionado.nome` falha com `Model "Vinculo" has no field "nome"`.
 *
 * Quando a variante mora na MESMA tabela da base (o caso do `@@base` sem `@@map` próprio), a
 * coluna está na linha relacionada. O pacote monta a referência dela com o alias da tabela
 * relacionada (emprestado da referência de uma coluna da base) e as comparações como expressão
 * crua do `db.raw.sql(...).returns("pg/bool@1")`, que o `where` do ORM aceita. Variante em
 * tabela própria fica de fora: o ORM responde o erro dele.
 */
import { getPrisma8 } from "./client";
import { EMPTY_SQL, joinSql, sql, SqlFragment, toTemplate } from "./sqlFragment";

interface RelacaoDoContrato {
  to?: { model?: string; namespace?: string };
  on?: { localFields?: string[]; targetFields?: string[] };
}

interface ContratoDeModel {
  fields?: Record<string, { type?: { codecId?: string } }>;
  relations?: Record<string, RelacaoDoContrato>;
  variants?: Record<string, { model?: string; namespace?: string }>;
  storage?: { table?: string; namespaceId?: string; fields?: Record<string, { column?: string }> };
}

interface Contrato {
  domain?: { namespaces?: Record<string, { models?: Record<string, ContratoDeModel> }> };
}

/** Onde a tradução está no contrato: o model da coleção, ou o alvo da relação percorrida. */
export interface ModelScope {
  contract: Contrato;
  namespace: string;
  model: string;
}

/** O escopo da coleção, lido dos metadados que a coleção real carrega. */
export function scopeOf(collection: unknown): ModelScope | undefined {
  const meta = collection as { contract?: Contrato; modelName?: string; namespaceId?: string };
  if (!meta?.contract || !meta.modelName) return undefined;
  return {
    contract: meta.contract,
    namespace: meta.namespaceId ?? "public",
    model: meta.modelName,
  };
}

const modelOf = (scope: ModelScope, model = scope.model, namespace = scope.namespace) =>
  scope.contract.domain?.namespaces?.[namespace]?.models?.[model];

/** O escopo do model do outro lado da relação `relacao`. */
export function scopeOfRelation(
  scope: ModelScope | undefined,
  relacao: string,
): ModelScope | undefined {
  const to = scope ? modelOf(scope)?.relations?.[relacao]?.to : undefined;
  if (!scope || !to?.model) return undefined;
  return { ...scope, model: to.model, namespace: to.namespace ?? scope.namespace };
}

interface ColunaDaVariante {
  column: string;
  codecId?: string;
}

/** Os campos das variantes guardadas na tabela da base: campo → coluna e codec. */
export function variantColumns(scope: ModelScope | undefined): Record<string, ColunaDaVariante> {
  const base = scope ? modelOf(scope) : undefined;
  if (!scope || !base?.variants) return {};
  const tabela = base.storage?.table;
  const colunas: Record<string, ColunaDaVariante> = {};
  for (const ref of Object.values(base.variants)) {
    const variante = modelOf(scope, ref.model ?? "", ref.namespace ?? scope.namespace);
    if (!variante || variante.storage?.table !== tabela) continue;
    for (const [campo, def] of Object.entries(variante.fields ?? {})) {
      colunas[campo] = {
        column: variante.storage?.fields?.[campo]?.column ?? campo,
        codecId: def.type?.codecId,
      };
    }
  }
  return colunas;
}

/** As variantes guardadas na tabela da base (as que a mesma linha carrega). */
function readVariantesNaTabela(scope: ModelScope): ContratoDeModel[] {
  const base = modelOf(scope);
  if (!base?.variants) return [];
  return Object.values(base.variants)
    .map((ref) => modelOf(scope, ref.model ?? "", ref.namespace ?? scope.namespace))
    .filter(
      (variante): variante is ContratoDeModel => variante?.storage?.table === base.storage?.table,
    );
}

/** A referência de uma coluna da base, para emprestar o alias da tabela relacionada. */
function readReferenciaDaBase(proxy: Record<string, any>, scope: ModelScope): unknown {
  const campo = Object.keys(modelOf(scope)?.fields ?? {})[0];
  const ref = campo ? proxy[campo]?.buildAst?.() : undefined;
  if (ref === undefined) {
    throw new Error(
      `[@mateusseiboth/ts-decorators] Não é possível montar a coluna da variante de "${scope.model}": nenhuma coluna da base respondeu.`,
    );
  }
  return ref;
}

/**
 * A coluna da variante na mesma tabela: `ColumnRef.of(alias, coluna)` pela classe da referência
 * da base. No fake do pacote a referência é o nome do campo, e a da variante também.
 */
function buildColumnRef(base: unknown, campo: string, coluna: string, alias?: string): unknown {
  if (typeof base === "string") return campo;
  const ref = base as {
    table?: unknown;
    constructor?: { of?: (t: unknown, c: string) => unknown };
  };
  if (typeof ref.constructor?.of === "function" && ref.table !== undefined) {
    return ref.constructor.of(alias ?? ref.table, coluna);
  }
  throw new Error(
    `[@mateusseiboth/ts-decorators] A referência de coluna desta versão do Prisma 8 não permite montar a coluna "${coluna}" da variante.`,
  );
}

const RETORNO_BOOLEANO = "pg/bool@1";

/** A coluna da variante como campo do filtro: as comparações viram expressão crua booleana. */
function buildVariantField(columnRef: unknown, codecId: string | undefined) {
  const coluna = { buildAst: () => columnRef };
  const booleano = (trecho: ReturnType<typeof sql>) =>
    (getPrisma8().db as any).raw.sql(...toTemplate(trecho)).returns(RETORNO_BOOLEANO);
  const lista = (valores: unknown[]) =>
    joinSql(
      valores.map((valor) => sql`${valor}`),
      ", ",
    );
  return {
    returnType: { codecId },
    buildAst: () => columnRef,
    eq: (valor: unknown) => booleano(sql`${coluna} = ${valor}`),
    neq: (valor: unknown) => booleano(sql`${coluna} <> ${valor}`),
    in: (valores: unknown[]) =>
      booleano(valores.length ? sql`${coluna} IN (${lista(valores)})` : sql`FALSE`),
    notIn: (valores: unknown[]) =>
      booleano(valores.length ? sql`${coluna} NOT IN (${lista(valores)})` : sql`TRUE`),
    gt: (valor: unknown) => booleano(sql`${coluna} > ${valor}`),
    gte: (valor: unknown) => booleano(sql`${coluna} >= ${valor}`),
    lt: (valor: unknown) => booleano(sql`${coluna} < ${valor}`),
    lte: (valor: unknown) => booleano(sql`${coluna} <= ${valor}`),
    like: (padrao: string) => booleano(sql`${coluna} LIKE ${padrao}`),
    ilike: (padrao: string) => booleano(sql`${coluna} ILIKE ${padrao}`),
    isNull: () => booleano(sql`${coluna} IS NULL`),
    isNotNull: () => booleano(sql`${coluna} IS NOT NULL`),
  };
}

/**
 * O acessor da relação com os campos das variantes da mesma tabela. Campo da base (ou relação)
 * segue pelo acessor do ORM; sem variante no escopo, devolve o acessor como veio.
 */
export function withVariantFields<P extends Record<string, any>>(
  proxy: P,
  scope: ModelScope | undefined,
): P {
  const colunas = variantColumns(scope);
  if (!scope || Object.keys(colunas).length === 0) return proxy;
  return new Proxy(proxy, {
    get(alvo, campo) {
      if (typeof campo !== "string" || !Object.hasOwn(colunas, campo)) {
        return Reflect.get(alvo, campo);
      }
      const { column, codecId } = colunas[campo]!;
      return buildVariantField(
        buildColumnRef(readReferenciaDaBase(alvo, scope), campo, column),
        codecId,
      );
    },
  });
}

/**
 * RELAÇÃO de uma variante, pedida na coleção da BASE (`TituloFinanceiro` com `fornecedor`, que é
 * da variante `TituloAPagar`). O ORM não a enxerga na base (`Model "TituloFinanceiro" has no
 * field "fornecedor"`). Com a variante na mesma tabela, a chave estrangeira está na linha: a
 * relação vira uma subconsulta correlacionada pela coluna da chave. A linha de outra variante tem
 * a chave nula: fica sem valor na ordem e não casa no filtro.
 */
export interface VariantRelation {
  /** O escopo do model do outro lado (para os filtros aninhados). */
  alvo: ModelScope;
  campoLocal: string;
  colunaLocal: string;
  campoAlvo: string;
  colunaAlvo: string;
  tabelaAlvo: string;
  schemaAlvo?: string;
}

/** A relação `relacao` de uma variante na mesma tabela da base; `undefined` se não for o caso. */
export function variantRelation(
  scope: ModelScope | undefined,
  relacao: string,
): VariantRelation | undefined {
  if (!scope || modelOf(scope)?.relations?.[relacao]) return undefined;
  for (const variante of readVariantesNaTabela(scope)) {
    const def = variante.relations?.[relacao];
    if (!def) continue;
    const campoLocal = def.on?.localFields?.[0];
    const campoAlvo = def.on?.targetFields?.[0];
    const alvoModel = def.to?.model;
    if (!campoLocal || !campoAlvo || !alvoModel || (def.on?.localFields?.length ?? 0) > 1) {
      throw new Error(
        `[@mateusseiboth/ts-decorators] A relação "${relacao}" da variante precisa de uma chave estrangeira de uma coluna.`,
      );
    }
    const alvo = { ...scope, model: alvoModel, namespace: def.to?.namespace ?? scope.namespace };
    const contratoDoAlvo = modelOf(alvo);
    return {
      alvo,
      campoLocal,
      colunaLocal: variante.storage?.fields?.[campoLocal]?.column ?? campoLocal,
      campoAlvo,
      colunaAlvo: contratoDoAlvo?.storage?.fields?.[campoAlvo]?.column ?? campoAlvo,
      tabelaAlvo: contratoDoAlvo?.storage?.table ?? alvoModel,
      schemaAlvo: contratoDoAlvo?.storage?.namespaceId,
    };
  }
  return undefined;
}

/** Identificador entre aspas: o nome vem do contrato, mas nunca entra no SQL sem escape. */
const ident = (nome: string): string => `"${nome.replaceAll('"', '""')}"`;

const texto = (valor: string): SqlFragment => new SqlFragment([valor], []);

/** Expressão para o `raw.sql`: a do ORM já tem `buildAst`; o nó do AST ganha um. */
const asExpression = (valor: unknown): unknown =>
  typeof (valor as { buildAst?: unknown })?.buildAst === "function"
    ? valor
    : { buildAst: () => valor };

const CODEC_PADRAO = "pg/text@1";

interface LinhasDaRelacao {
  /** ` FROM "schema"."tabela" AS "alias" WHERE alias.alvo = base.chave` */
  origem: SqlFragment;
  /** A coluna `campo` do model do outro lado, pelo alias da subconsulta. */
  colunaDe(campo: string): { ref: unknown; codecId?: string };
}

function buildLinhas(
  rootProxy: Record<string, any>,
  scope: ModelScope,
  relacao: string,
  rel: VariantRelation,
): LinhasDaRelacao {
  const base = readReferenciaDaBase(rootProxy, scope);
  const alias = `_rel_${relacao.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const tabela = `${rel.schemaAlvo ? `${ident(rel.schemaAlvo)}.` : ""}${ident(rel.tabelaAlvo)}`;
  const chave = { buildAst: () => buildColumnRef(base, rel.campoLocal, rel.colunaLocal) };
  const alvo = { buildAst: () => buildColumnRef(base, rel.campoAlvo, rel.colunaAlvo, alias) };
  const contrato = modelOf(rel.alvo);
  return {
    origem: sql`${texto(` FROM ${tabela} AS ${ident(alias)} WHERE `)}${alvo} = ${chave}`,
    colunaDe: (campo) => ({
      ref: buildColumnRef(base, campo, contrato?.storage?.fields?.[campo]?.column ?? campo, alias),
      codecId: contrato?.fields?.[campo]?.type?.codecId,
    }),
  };
}

const rawSql = (trecho: SqlFragment) => (getPrisma8().db as any).raw.sql(...toTemplate(trecho));

/** A coluna `campo` do outro lado da relação da variante, para o `ORDER BY` (nó do AST). */
export function buildVariantRelationOrder(
  rootProxy: Record<string, any>,
  scope: ModelScope,
  relacao: string,
  rel: VariantRelation,
  campo: string,
): unknown {
  const linhas = buildLinhas(rootProxy, scope, relacao, rel);
  const { ref, codecId } = linhas.colunaDe(campo);
  return rawSql(sql`(SELECT ${{ buildAst: () => ref }}${linhas.origem})`)
    .returns({ codecId: codecId ?? CODEC_PADRAO, nullable: true })
    .buildAst();
}

/** O acessor do outro lado da relação da variante, com as colunas do model alvo. */
export function buildVariantRelationProxy(
  rootProxy: Record<string, any>,
  scope: ModelScope,
  relacao: string,
  rel: VariantRelation,
): Record<string, unknown> {
  const linhas = buildLinhas(rootProxy, scope, relacao, rel);
  const campos = Object.keys(modelOf(rel.alvo)?.fields ?? {});
  return Object.fromEntries(
    campos.map((campo) => {
      const { ref, codecId } = linhas.colunaDe(campo);
      return [campo, buildVariantField(ref, codecId)];
    }),
  );
}

/** `EXISTS` (ou `NOT EXISTS`) do relacionado da variante, com a condição aninhada. */
export function buildVariantRelationExists(
  rootProxy: Record<string, any>,
  scope: ModelScope,
  relacao: string,
  rel: VariantRelation,
  condicao: unknown,
  negar = false,
): unknown {
  const linhas = buildLinhas(rootProxy, scope, relacao, rel);
  const extra = condicao === undefined ? EMPTY_SQL : sql` AND (${asExpression(condicao)})`;
  const existe = negar ? texto("NOT EXISTS") : texto("EXISTS");
  return rawSql(sql`${existe} (SELECT 1${linhas.origem}${extra})`).returns(RETORNO_BOOLEANO);
}

/** A chave estrangeira nula: a linha não tem o relacionado (ou é de outra variante). */
export function buildVariantRelationIsNull(
  rootProxy: Record<string, any>,
  scope: ModelScope,
  rel: VariantRelation,
  negar = false,
): unknown {
  const base = readReferenciaDaBase(rootProxy, scope);
  const campo = buildVariantField(buildColumnRef(base, rel.campoLocal, rel.colunaLocal), undefined);
  return negar ? campo.isNotNull() : campo.isNull();
}

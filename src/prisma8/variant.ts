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
import { joinSql, sql, toTemplate } from "./sqlFragment";

interface ContratoDeModel {
  fields?: Record<string, { type?: { codecId?: string } }>;
  relations?: Record<string, { to?: { model?: string; namespace?: string } }>;
  variants?: Record<string, { model?: string; namespace?: string }>;
  storage?: { table?: string; fields?: Record<string, { column?: string }> };
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
function buildColumnRef(base: unknown, campo: string, coluna: string): unknown {
  if (typeof base === "string") return campo;
  const ref = base as {
    table?: unknown;
    constructor?: { of?: (t: unknown, c: string) => unknown };
  };
  if (typeof ref.constructor?.of === "function" && ref.table !== undefined) {
    return ref.constructor.of(ref.table, coluna);
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

/**
 * Traduz o `orderBy` do Prisma 7 (`{ name: "asc" }`, `[{ a: "desc" }, { b: { sort: "asc" } }]`)
 * para as lambdas do Prisma 8 (`(f) => f.name.asc()`).
 *
 * Ordenar por campo de RELAÇÃO to-one (`{ setor: { name: "asc" } }`) não existe na API do ORM:
 * vira `ORDER BY (SELECT setor.name FROM setor WHERE setor.id = bairro.setor_id)`, montado com a
 * subconsulta correlacionada que o próprio ORM gera para o filtro de relação (ver
 * `alvoNaRelacao`). Precisa das classes do AST em `configurePrisma8({ ..., ast })`; sem elas
 * falha alto, porque silenciar mudaria a ordem da listagem sem ninguém perceber.
 *
 * Coluna `Boolean` é caso à parte e tem resgate — ver `itemEmprestado`.
 */

import { getPrisma8Ast, type Prisma8Ast } from "./client";
import {
  buildVariantRelationOrder,
  scopeOf,
  scopeOfRelation,
  variantRelation,
  withVariantFields,
  type ModelScope,
  type VariantRelation,
} from "./variant";

type Direction = "asc" | "desc";

interface OrderableField {
  asc(): unknown;
  desc(): unknown;
}

/** Toda coluna sabe devolver a própria expressão, tenha ela `asc` ou não. */
interface ColumnField {
  buildAst(): unknown;
}

/** A classe do item de ordenação, alcançada pelo que um campo ordenável devolve. */
interface OrderByItemFactory {
  asc(expr: unknown): unknown;
  desc(expr: unknown): unknown;
}

/** O acessor de relação: o `some` devolve o `EXISTS` com a subconsulta correlacionada. */
interface RelationField {
  some(predicate: (related: Proxy) => undefined): {
    subquery: { withProjection(projection: unknown[]): unknown };
  };
}

type Proxy = Record<
  string,
  (OrderableField & Partial<ColumnField> & Partial<RelationField>) | undefined
>;

/** A expressão que o `ORDER BY` ordena e em que direção. */
interface Alvo {
  expr: unknown;
  direction: Direction;
}

interface Orderable {
  orderBy(lambdas: Array<(proxy: any) => unknown>): any;
}

function directionOf(fieldName: string, value: unknown): Direction {
  if (value === "asc" || value === "desc") return value;
  const sort = (value as { sort?: unknown } | undefined)?.sort;
  if (sort === "asc" || sort === "desc") return sort;
  throw new Error(
    `[@mateusseiboth/ts-decorators] Não é possível ordenar por "${fieldName}" no Prisma 8: esperado "asc"/"desc", veio ${JSON.stringify(value)}.`,
  );
}

const ORDER: Record<Direction, (field: OrderableField) => unknown> = {
  asc: (field) => field.asc(),
  desc: (field) => field.desc(),
};

/**
 * Ordena a coluna que o ORM se recusa a ordenar — hoje, toda coluna `Boolean`.
 *
 * O codec `bool` do Postgres declara os traits `equality` e `boolean`, mas NÃO `order`, e
 * `asc`/`desc` só nascem no acessor com o trait `order`. Resultado: clicar no cabeçalho STATUS
 * de uma listagem morria em "campo inexistente ou relação" numa coluna que existe e que o
 * Postgres ordena sem reclamar (`false` antes de `true`).
 *
 * O item de ordenação é instância de uma classe com fábricas estáticas (`OrderByItem.asc(expr)`)
 * que o pacote não exporta. Então ela vem EMPRESTADA de um campo irmão que o ORM aceita ordenar,
 * e a expressão vem da própria coluna (`buildAst()`). Para o framework o item é o mesmo — ele
 * consome pelo tipo, não pela origem.
 */
function itemEmprestado(
  proxy: Proxy,
  campos: string[],
  expr: unknown,
  direction: Direction,
): unknown | undefined {
  for (const nome of campos) {
    const irmao = proxy[nome];
    if (typeof irmao?.asc !== "function") continue;
    const fabrica = (Object.getPrototypeOf(irmao.asc()) as { constructor?: unknown })
      ?.constructor as OrderByItemFactory | undefined;
    if (typeof fabrica?.[direction] === "function") return fabrica[direction](expr);
  }
  return undefined;
}

/** `{ name: "asc" }` debaixo de uma relação é caminho; `{ sort: "asc" }` é direção. */
const isCaminho = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && !("sort" in value);

const isRelation = (field: unknown): field is RelationField =>
  typeof (field as RelationField | undefined)?.some === "function";

function requireAst(relacao: string): Prisma8Ast {
  const ast = getPrisma8Ast();
  if (ast) return ast;
  throw new Error(
    `[@mateusseiboth/ts-decorators] Não é possível ordenar pela relação "${relacao}": registre as classes do AST em configurePrisma8({ ..., ast: { SubqueryExpr, ProjectionItem } }), de "@prisma/orm-postgres/relational-core/ast".`,
  );
}

/** O único campo de um nível do caminho: dois campos no mesmo nível não dizem qual vem antes. */
function passoDoCaminho(relacao: string, caminho: Record<string, unknown>): [string, unknown] {
  const passos = Object.entries(caminho);
  if (passos.length === 1) return passos[0]!;
  throw new Error(
    `[@mateusseiboth/ts-decorators] Ordenação pela relação "${relacao}" precisa de UM campo por nível, veio ${JSON.stringify(caminho)}.`,
  );
}

/**
 * A coluna da relação como subconsulta: o `some` do ORM monta o `EXISTS` correlacionado com o
 * pai (o mesmo join do filtro de relação), e a projeção dele é trocada pela coluna pedida. O
 * predicado roda na hora, dentro do escopo da relação, e é ali que a coluna é resolvida.
 */
function alvoNaRelacao(
  relacao: string,
  field: RelationField,
  caminho: Record<string, unknown>,
  scope?: ModelScope,
): Alvo {
  const ast = requireAst(relacao);
  const [campo, resto] = passoDoCaminho(relacao, caminho);
  const alvos: Alvo[] = [];
  // O acessor do relacionado ganha os campos das variantes do model alvo (ver `variant.ts`).
  const existe = field.some((relacionado) => {
    alvos.push(alvoDoCampo(withVariantFields(relacionado, scope), campo, resto, scope));
    return undefined;
  });
  const alvo = alvos[0];
  if (!alvo)
    throw new Error(
      `[@mateusseiboth/ts-decorators] A relação "${relacao}" não resolveu "${campo}".`,
    );
  const subconsulta = existe.subquery.withProjection([ast.ProjectionItem.of("_ordem", alvo.expr)]);
  return { expr: ast.SubqueryExpr.of(subconsulta), direction: alvo.direction };
}

function alvoDoCampo(proxy: Proxy, campo: string, valor: unknown, scope?: ModelScope): Alvo {
  const field = proxy[campo];
  if (isCaminho(valor) && isRelation(field)) {
    return alvoNaRelacao(campo, field, valor, scopeOfRelation(scope, campo));
  }
  if (typeof field?.buildAst === "function") {
    return { expr: field.buildAst(), direction: directionOf(campo, valor) };
  }
  throw new Error(
    `[@mateusseiboth/ts-decorators] Não é possível ordenar por "${campo}" no Prisma 8 (campo inexistente).`,
  );
}

function lambdaDaRelacao(
  fieldName: string,
  caminho: Record<string, unknown>,
  campos: string[],
  scope?: ModelScope,
) {
  return (proxy: Proxy) => {
    const field = proxy[fieldName];
    if (!isRelation(field)) {
      throw new Error(
        `[@mateusseiboth/ts-decorators] Não é possível ordenar por "${fieldName}" no Prisma 8: esperado "asc"/"desc" (o campo não é relação), veio ${JSON.stringify(caminho)}.`,
      );
    }
    const alvo = alvoNaRelacao(fieldName, field, caminho, scopeOfRelation(scope, fieldName));
    const item = itemEmprestado(proxy, campos, alvo.expr, alvo.direction);
    if (item !== undefined) return item;
    throw new Error(
      `[@mateusseiboth/ts-decorators] Não é possível ordenar pela relação "${fieldName}": nenhuma coluna do model é ordenável para montar o item de ordenação.`,
    );
  };
}

/**
 * Ordenação pela relação de uma VARIANTE, na coleção da base (ver `variant.ts`): a coluna do
 * relacionado por subconsulta correlacionada pela chave estrangeira. A linha de outra variante
 * fica sem valor: no fim na ordem crescente e no começo na decrescente (padrão do Postgres).
 */
function lambdaDaRelacaoDaVariante(
  fieldName: string,
  caminho: Record<string, unknown>,
  campos: string[],
  scope: ModelScope,
  rel: VariantRelation,
) {
  return (proxy: Proxy) => {
    const [campo, valor] = passoDoCaminho(fieldName, caminho);
    if (isCaminho(valor)) {
      throw new Error(
        `[@mateusseiboth/ts-decorators] A relação "${fieldName}" da variante ordena por um campo do model relacionado, não por outra relação.`,
      );
    }
    const expr = buildVariantRelationOrder(proxy, scope, fieldName, rel, campo);
    const item = itemEmprestado(proxy, campos, expr, directionOf(campo, valor));
    if (item !== undefined) return item;
    throw new Error(
      `[@mateusseiboth/ts-decorators] Não é possível ordenar pela relação "${fieldName}": nenhuma coluna do model é ordenável para montar o item de ordenação.`,
    );
  };
}

function lambdaFor(fieldName: string, value: unknown, campos: string[], scope?: ModelScope) {
  if (isCaminho(value)) {
    const daVariante = variantRelation(scope, fieldName);
    if (daVariante) return lambdaDaRelacaoDaVariante(fieldName, value, campos, scope!, daVariante);
    return lambdaDaRelacao(fieldName, value, campos, scope);
  }
  const direction = directionOf(fieldName, value);
  return (proxy: Proxy) => {
    // Campo de variante na coleção da base: a coluna vem pela tabela da base.
    const field = withVariantFields(proxy, scope)[fieldName];
    if (typeof field?.asc === "function") return ORDER[direction](field);

    if (typeof field?.buildAst === "function") {
      const item = itemEmprestado(proxy, campos, field.buildAst(), direction);
      if (item !== undefined) return item;
      throw new Error(
        `[@mateusseiboth/ts-decorators] Não é possível ordenar por "${fieldName}" no Prisma 8: a coluna existe mas o ORM não a ordena (codec sem o trait "order"), e nenhum campo irmão do model é ordenável para servir de empréstimo.`,
      );
    }

    throw new Error(
      `[@mateusseiboth/ts-decorators] Não é possível ordenar por "${fieldName}" no Prisma 8 (campo inexistente ou relação).`,
    );
  };
}

export function orderByLambdas(
  orderBy: unknown,
  campos: string[] = [],
  scope?: ModelScope,
): Array<(proxy: Proxy) => unknown> {
  if (!orderBy) return [];
  const items = (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(Boolean) as Array<
    Record<string, unknown>
  >;
  return items.flatMap((item) =>
    Object.entries(item).map(([field, value]) => lambdaFor(field, value, campos, scope)),
  );
}

interface ContractLike {
  domain?: {
    namespaces?: Record<string, { models?: Record<string, { fields?: Record<string, unknown> }> }>;
  };
}

/** Colunas do model, lidas do contrato que a coleção carrega; vazio quando não há contrato. */
function fieldNames(collection: unknown): string[] {
  const meta = collection as { contract?: ContractLike; modelName?: string; namespaceId?: string };
  const model =
    meta.contract?.domain?.namespaces?.[meta.namespaceId ?? "public"]?.models?.[
      meta.modelName ?? ""
    ];
  return Object.keys(model?.fields ?? {});
}

/** Encadeia o `orderBy` do Prisma 7 na coleção; sem ordenação, devolve a coleção intacta. */
export function applyOrderBy<T extends Orderable>(collection: T, orderBy: unknown): T {
  const lambdas = orderByLambdas(orderBy, fieldNames(collection), scopeOf(collection));
  if (lambdas.length === 0) return collection;
  return collection.orderBy(lambdas);
}

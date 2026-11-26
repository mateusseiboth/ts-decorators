/**
 * Traduz o `where` do Prisma 7 (objeto: `{ name: { contains: "x", mode: "insensitive" } }`)
 * para o predicado do Prisma 8 (lambda sobre o proxy de campo: `b.name.ilike("%x%")`).
 *
 * Existe porque `getWhere`/`buildWhereFromQuery` continuam produzindo o objeto do 7 a partir
 * da query string, e os DAOs migrados não precisam reescrever cada filtro à mão.
 *
 * Regras:
 * - escalar → `eq`; `null` → `isNull`; `{ in, notIn, gt, gte, lt, lte, equals, not }` → operador;
 * - `contains`/`startsWith`/`endsWith` → `like`, ou `ilike` com `mode: "insensitive"`, com o
 *   termo ESCAPADO (o Prisma 7 trata como literal, não como padrão); em coluna sem LIKE
 *   (`uuid`) viram igualdade;
 * - `AND`/`OR`/`NOT` → combinadores registrados em `configurePrisma8`;
 * - relação: objeto plano → `some(...)`; `some`/`every`/`none`/`is`/`isNot` explícitos.
 */
import { getPrisma8 } from "./client";
import { encodeForCodec, type FieldCodec } from "./temporal";
import { scopeOf, scopeOfRelation, withVariantFields, type ModelScope } from "./variant";

type Expression = unknown;

interface FieldProxy {
  /** Codec da coluna até a 8.0.0-rc.17. */
  codec?: FieldCodec;
  /** Da 8.0.0-rc.18 em diante: `codec` é o ref ligado à coluna, `codecId` o declarado. */
  returnType?: { codecId?: string; codec?: FieldCodec };
  eq(value: unknown): Expression;
  neq(value: unknown): Expression;
  in(values: unknown[]): Expression;
  notIn(values: unknown[]): Expression;
  gt(value: unknown): Expression;
  gte(value: unknown): Expression;
  lt(value: unknown): Expression;
  lte(value: unknown): Expression;
  like(pattern: string): Expression;
  ilike(pattern: string): Expression;
  isNull(): Expression;
  isNotNull(): Expression;
}

interface RelationProxy {
  some(predicate?: (related: ModelProxy) => Expression | undefined): Expression;
  every(predicate: (related: ModelProxy) => Expression | undefined): Expression;
  none(predicate?: (related: ModelProxy) => Expression | undefined): Expression;
}

export type ModelProxy = Record<string, FieldProxy | RelationProxy | undefined>;

type WhereObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function isRelationProxy(target: unknown): target is RelationProxy {
  return typeof (target as RelationProxy | undefined)?.some === "function";
}

function isFieldProxy(target: unknown): target is FieldProxy {
  return typeof (target as FieldProxy | undefined)?.eq === "function";
}

function asList(value: unknown): WhereObject[] {
  return (Array.isArray(value) ? value : [value]).filter(isPlainObject);
}

/** Junta N expressões: nenhuma → `undefined`; uma → ela mesma; várias → `and(...)`. */
function conjunction(parts: Expression[]): Expression | undefined {
  const present = parts.filter((p) => p !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return getCombinators().and(...present);
}

function getCombinators() {
  const { and, or, not } = getPrisma8();
  return { and, or, not };
}

/** `%`, `_` e `\` do termo viram literais: o Prisma 7 nunca interpretou o valor como padrão. */
export function escapeLike(term: unknown): string {
  return String(term).replace(/[\\%_]/g, "\\$&");
}

function likeOf(field: FieldProxy, mode: unknown) {
  return mode === "insensitive" ? field.ilike.bind(field) : field.like.bind(field);
}

/** A coluna aceita LIKE? `uuid`, número e data não têm `like`/`ilike` no proxy do Prisma 8. */
const hasLike = (field: FieldProxy): boolean =>
  typeof field.like === "function" && typeof field.ilike === "function";

/**
 * `contains`/`startsWith`/`endsWith` com o padrão montado, ou IGUALDADE em coluna sem LIKE.
 *
 * As telas mandam `?bairroId=contains:<uuid>` desde o Prisma 7, quando o id era texto; no 8 a
 * coluna é `uuid` e o filtro morria com "field.ilike.bind" (500). Igualdade é o que o
 * `getWhere` já faz com `contains` em campo numérico.
 */
const textMatch =
  (pattern: (term: string) => string): ScalarOp =>
  (field, value, mode) =>
    hasLike(field)
      ? likeOf(field, mode)(pattern(escapeLike(value)))
      : field.eq(encoded(field, value));

type ScalarOp = (field: FieldProxy, value: unknown, mode: unknown) => Expression;

/**
 * O codec da coluna, onde quer que a versão do Prisma 8 o ponha. A rc.18 tirou `field.codec` e
 * passou a informação para `field.returnType`; lendo só o lugar antigo, nada era convertido e o
 * filtro por enum voltava vazio sem erro. Sem ref ligado à coluna, vale o `codecId` declarado,
 * a mesma ordem que o `codecOf` do próprio Prisma segue.
 */
function readCodec(field: FieldProxy): FieldCodec | string | undefined {
  return field.codec ?? field.returnType?.codec ?? field.returnType?.codecId;
}

/** `Date`/ISO em campo temporal vira `Temporal`; rótulo de enum vira valor; o resto passa. */
function encoded(field: FieldProxy, value: unknown): unknown {
  return encodeForCodec(value, readCodec(field));
}

function encodedList(field: FieldProxy, value: unknown): unknown[] {
  return (value as unknown[]).map((item) => encoded(field, item));
}

/**
 * `equals` do Prisma 7. Com `mode: "insensitive"` em coluna de texto é o termo INTEIRO num
 * `ilike` (escapado, sem curinga): `eq` aqui fazia o login por e-mail diferenciar maiúsculas.
 */
const equalsOf: ScalarOp = (field, value, mode) => {
  if (value === null) return field.isNull();
  if (mode === "insensitive" && hasLike(field)) return field.ilike(escapeLike(value));
  return field.eq(encoded(field, value));
};

const SCALAR_OPS: Record<string, ScalarOp> = {
  equals: equalsOf,
  not: (field, value) => notOf(field, value),
  in: (field, value) => field.in(encodedList(field, value)),
  notIn: (field, value) => field.notIn(encodedList(field, value)),
  gt: (field, value) => field.gt(encoded(field, value)),
  gte: (field, value) => field.gte(encoded(field, value)),
  lt: (field, value) => field.lt(encoded(field, value)),
  lte: (field, value) => field.lte(encoded(field, value)),
  contains: textMatch((term) => `%${term}%`),
  startsWith: textMatch((term) => `${term}%`),
  endsWith: textMatch((term) => `%${term}`),
};

function notOf(field: FieldProxy, value: unknown): Expression {
  if (value === null) return field.isNotNull();
  if (!isPlainObject(value)) return field.neq(encoded(field, value));
  const inner = conjunction(scalarPredicates(field, value));
  if (inner === undefined)
    throw new Error("[@mateusseiboth/ts-decorators] `not: {}` vazio no filtro.");
  return getCombinators().not(inner);
}

function scalarPredicates(field: FieldProxy, value: unknown): Expression[] {
  if (value === null) return [field.isNull()];
  if (!isPlainObject(value)) return [field.eq(encoded(field, value))];
  const mode = value.mode;
  return Object.entries(value)
    .filter(([op]) => op !== "mode")
    .map(([op, operand]) => {
      const run = SCALAR_OPS[op];
      if (!run)
        throw new Error(
          `[@mateusseiboth/ts-decorators] Operador de filtro sem equivalente no Prisma 8: ${op}`,
        );
      return run(field, operand, mode);
    });
}

type Nested = (value: unknown) => ((related: ModelProxy) => Expression | undefined) | undefined;

type RelationOp = (relation: RelationProxy, value: unknown, nested: Nested) => Expression;

const RELATION_OPS: Record<string, RelationOp> = {
  some: (relation, value, nested) => relation.some(nested(value)),
  every: (relation, value, nested) => relation.every(nested(value) ?? (() => undefined)),
  none: (relation, value, nested) => relation.none(nested(value)),
  is: (relation, value, nested) =>
    value === null ? relation.none() : relation.some(nested(value)),
  isNot: (relation, value, nested) =>
    value === null ? relation.some() : getCombinators().not(relation.some(nested(value))),
};

/**
 * Predicado aninhado para a relação; `{}` vira `undefined` (todos os relacionados). O acessor do
 * relacionado ganha os campos das variantes do model alvo (ver `variant.ts`).
 */
const buildNested =
  (scope: ModelScope | undefined): Nested =>
  (value) => {
    if (!isPlainObject(value) || Object.keys(value).length === 0) return undefined;
    return (related) => buildPredicate(withVariantFields(related, scope), value, scope);
  };

function relationPredicate(
  relation: RelationProxy,
  value: unknown,
  scope: ModelScope | undefined,
): Expression {
  if (value === null) return relation.none();
  if (!isPlainObject(value))
    throw new Error("[@mateusseiboth/ts-decorators] Filtro de relação precisa ser objeto ou null.");
  const nested = buildNested(scope);
  const explicit = Object.keys(value).filter((key) => key in RELATION_OPS);
  if (explicit.length === 0) return relation.some(nested(value));
  return conjunction(explicit.map((op) => RELATION_OPS[op]!(relation, value[op], nested)))!;
}

type LogicalOp = (proxy: ModelProxy, value: unknown, scope?: ModelScope) => Expression[];

/**
 * Cada operador lógico contribui com as partes de UMA conjunção: `AND` espalha as partes de
 * cada sub-where (fica plano, sem `and(and(...))`), `OR` e `NOT` viram uma parte cada.
 */
const LOGICAL_OPS: Record<string, LogicalOp> = {
  AND: (proxy, value, scope) => asList(value).flatMap((w) => buildParts(proxy, w, scope)),
  OR: (proxy, value, scope) => {
    const parts = asList(value)
      .map((w) => buildPredicate(proxy, w, scope))
      .filter((p) => p !== undefined);
    if (parts.length === 0) return [];
    if (parts.length === 1) return [parts[0]];
    return [getCombinators().or(...parts)];
  },
  NOT: (proxy, value, scope) => {
    const inner = conjunction(asList(value).map((w) => buildPredicate(proxy, w, scope)));
    if (inner === undefined) return [];
    return [getCombinators().not(inner)];
  },
};

function fieldPredicates(
  proxy: ModelProxy,
  key: string,
  value: unknown,
  scope?: ModelScope,
): Expression[] {
  const target = proxy[key];
  if (isRelationProxy(target)) {
    return [relationPredicate(target, value, scopeOfRelation(scope, key))];
  }
  if (isFieldProxy(target)) return scalarPredicates(target, value);
  throw new Error(`[@mateusseiboth/ts-decorators] Campo desconhecido no filtro: ${key}`);
}

function buildParts(proxy: ModelProxy, where: unknown, scope?: ModelScope): Expression[] {
  if (!isPlainObject(where)) return [];
  return Object.entries(where)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) =>
      (LOGICAL_OPS[key] ?? ((p, v, s) => fieldPredicates(p, key, v, s)))(proxy, value, scope),
    );
}

/**
 * Monta a expressão do Prisma 8 para um `where` do Prisma 7. `undefined` quando não há
 * condição nenhuma (o chamador não deve encadear `.where` nesse caso).
 */
export function buildPredicate(
  proxy: ModelProxy,
  where: unknown,
  scope?: ModelScope,
): Expression | undefined {
  return conjunction(buildParts(proxy, where, scope));
}

interface Filterable {
  where(predicate: (proxy: any) => unknown): any;
}

/** Encadeia o `where` do Prisma 7 na coleção; sem condição, devolve a coleção intacta. */
export function applyWhere<T extends Filterable>(collection: T, where: unknown): T {
  if (!isPlainObject(where) || Object.keys(where).length === 0) return collection;
  const scope = scopeOf(collection);
  return collection.where((proxy: ModelProxy) => {
    const predicate = buildPredicate(proxy, where, scope);
    if (predicate === undefined)
      throw new Error("[@mateusseiboth/ts-decorators] Filtro sem condição efetiva.");
    return predicate;
  });
}

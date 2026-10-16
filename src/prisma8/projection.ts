/**
 * Traduz `select`/`include`/`distinct` do Prisma 7 para `.select(...)`/`.include(...)`/
 * `.distinctOn(...)` do Prisma 8.
 *
 * O Prisma 7 aceita `select: { setor: true }` para trazer a relação inteira; no 8 `select` é só
 * coluna e relação vai por `include`. Quem separa os dois é o CONTRATO que a própria coleção
 * carrega (`collection.contract.domain.namespaces[ns].models[model].relations`).
 */
import { applyQueryOptions, collectionMeta, type OrmCollection, type QueryOptions } from "./query";

interface Projectable {
  select(...fields: string[]): any;
  include(relation: string, refine?: (branch: any) => any): any;
  distinct(): any;
  distinctOn(...fields: string[]): any;
}

export interface ProjectionOptions {
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  distinct?: string | string[];
}

interface ContractModel {
  relations?: Record<string, unknown>;
}

function contractModel(collection: Projectable): ContractModel | undefined {
  const meta = collectionMeta(collection as OrmCollection);
  const contract = meta.contract as
    | { domain?: { namespaces?: Record<string, { models?: Record<string, ContractModel> }> } }
    | undefined;
  const namespace = contract?.domain?.namespaces?.[meta.namespaceId ?? "public"];
  return namespace?.models?.[meta.modelName ?? ""];
}

export function isRelationField(collection: Projectable, field: string): boolean {
  return !!contractModel(collection)?.relations?.[field];
}

function requireKnown(field: string): void {
  if (field === "_count")
    throw new Error(
      "[@mateusseiboth/ts-decorators] `_count` não existe no Prisma 8: use include com reducer (`posts.count()`).",
    );
}

function refinement(value: unknown) {
  if (value === true) return undefined;
  return (branch: OrmCollection) => applyQueryOptions(branch, value as QueryOptions);
}

function applyInclude<T extends Projectable>(collection: T, include: Record<string, unknown>): T {
  return Object.entries(include)
    .filter(([, value]) => !!value)
    .reduce((current, [relation, value]) => {
      requireKnown(relation);
      return current.include(relation, refinement(value));
    }, collection);
}

function applySelect<T extends Projectable>(collection: T, select: Record<string, unknown>): T {
  const chosen = Object.entries(select).filter(([, value]) => !!value);
  chosen.forEach(([field]) => requireKnown(field));
  const scalars = chosen
    .filter(([field]) => !isRelationField(collection, field))
    .map(([field]) => field);
  const relations = Object.fromEntries(
    chosen.filter(([field]) => isRelationField(collection, field)),
  );
  const projected = scalars.length ? collection.select(...scalars) : collection;
  return applyInclude(projected, relations);
}

/**
 * `distinct` do Prisma 7 → `distinctOn(...)` quando há `orderBy` (o `DISTINCT ON` do Postgres
 * exige a ordem, e o tipo do Prisma 8 é `never` sem ela); sem ordem, `distinct()` sobre a
 * projeção, que é o que uma listagem de valores distintos quer.
 */
function applyDistinct<T extends Projectable>(collection: T, options: ProjectionOptions): T {
  const fields = Array.isArray(options.distinct) ? options.distinct : [options.distinct];
  const chosen = fields.filter(
    (field): field is string => typeof field === "string" && field.length > 0,
  );
  if (chosen.length === 0) return collection;
  const ordered = "orderBy" in options && !!(options as { orderBy?: unknown }).orderBy;
  if (ordered) return collection.distinctOn(...chosen);
  return collection.distinct();
}

/** Encadeia projeção e includes; sem nada pedido, devolve a coleção intacta. */
export function applyProjection<T extends Projectable>(
  collection: T,
  options: ProjectionOptions,
): T {
  const projected = options.select
    ? applySelect(collection, options.select)
    : options.include
      ? applyInclude(collection, options.include)
      : collection;
  return applyDistinct(projected, options);
}

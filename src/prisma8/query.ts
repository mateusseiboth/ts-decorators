/**
 * Consulta paginada no Prisma 8 com as MESMAS opções e a MESMA resposta do `executePrismaQuery`
 * (`{ data: { data, paginacao } }`), para que `BaseDAO.get`, `makePrismaOptions`, `getWhere`,
 * `getOrderBy`, `getPaginate` e `getColumns` continuem valendo sem mudar contrato de API.
 *
 * A coleção real (`tx.orm.public.<Model>`) tem tipos estreitos por model; aqui ela é tratada
 * pela FORMA (métodos encadeáveis), e o chamador recebe de volta o mesmo tipo que passou.
 */
import {
  applyColumnProjection,
  convertBigIntValues,
  buildPage,
  emptyPage,
  paginar,
  withResumo,
  type IResponsePaginate,
  type ResumoDaListagem,
  type SummaryOptions,
} from "../functions/sql";
import { applyOrderBy } from "./orderBy";
import { applyProjection, type ProjectionOptions } from "./projection";
import { decodeRowsForCollection } from "./temporal";
import { applyWhere } from "./where";

export interface QueryOptions extends ProjectionOptions {
  where?: unknown;
  orderBy?: unknown;
  skip?: number;
  take?: number;
}

export interface PagedQueryOptions extends QueryOptions {
  page?: number;
  /** Projeção vinda do `getColumns` (`?fields=`); estreita o `select` do chamador. */
  columns?: Record<string, unknown>;
  deriveTotal?: boolean;
  countTtlMs?: number;
  /** Soma e contagem sobre o filtro inteiro, em `data.resumo`. */
  summary?: SummaryOptions;
}

/**
 * O que o pacote usa de uma coleção do Prisma 8 — só a EXISTÊNCIA dos métodos. As assinaturas
 * reais são genéricas por model e não cabem numa interface estrutural sem importar o pacote;
 * o chamador recebe de volta o mesmo tipo que passou. `contract`/`modelName`/`namespaceId`
 * existem na coleção real mas são PRIVADOS na classe, então ficam fora da interface e são
 * lidos por `collectionMeta`.
 */
export interface OrmCollection {
  where: (...args: any[]) => any;
  select: (...args: any[]) => any;
  include: (...args: any[]) => any;
  distinct: (...args: any[]) => any;
  distinctOn: (...args: any[]) => any;
  orderBy: (...args: any[]) => any;
  limit: (...args: any[]) => any;
  offset: (...args: any[]) => any;
  all: (...args: any[]) => any;
  aggregate: (...args: any[]) => any;
}

/**
 * Total de linhas de uma coleção filtrada. `collection.count()` NÃO existe no topo (só como
 * reducer dentro de `include`); o caminho é `aggregate((a) => ({ n: a.count() }))`.
 */
export async function countRows(collection: OrmCollection): Promise<number> {
  const result = (await collection.aggregate((a: { count(): unknown }) => ({ n: a.count() }))) as {
    n: number;
  };
  return result.n;
}

/**
 * O que TODA leitura de DAO devolve: enums decodificados para o rótulo (pelo contrato da
 * coleção) e `bigint`/`Date`/`Temporal` serializados — o mesmo shape que o Prisma 7 entregava.
 */
export function readRows<T>(collection: OrmCollection, rows: T): T {
  return convertBigIntValues(decodeRowsForCollection(collection, rows));
}

/** Metadados que a coleção real carrega como campos privados (`contract`, `modelName`, `namespaceId`). */
export function collectionMeta(collection: OrmCollection): {
  contract?: unknown;
  modelName?: string;
  namespaceId?: string;
} {
  return collection as unknown as { contract?: unknown; modelName?: string; namespaceId?: string };
}

function applyPage<T extends OrmCollection>(collection: T, skip?: number, take?: number): T {
  const offset: T = skip != null ? collection.offset(skip) : collection;
  return take != null ? offset.limit(take) : offset;
}

/** where → orderBy → select/include/distinct → offset/limit, cada um só quando pedido. */
export function applyQueryOptions<T extends OrmCollection>(
  collection: T,
  options: QueryOptions,
): T {
  const filtered = applyWhere(collection, options.where);
  const ordered = applyOrderBy(filtered, options.orderBy);
  const projected = applyProjection(ordered, options);
  return applyPage(projected, options.skip, options.take);
}

/**
 * Listagem SEM paginação (`take` ausente): a tabela inteira, numa consulta só.
 *
 * O caminho paginado busca os ids e depois as linhas por `id in (...)`; sem `take` isso vira
 * `in` com a tabela inteira (227 mil ids num inventário de patrimônio) e o compilador da
 * consulta não termina. Aqui a projeção vai direto na consulta e a contagem é o próprio
 * tamanho, com o MESMO shape de resposta (inclusive o vazio).
 */
async function executeSemPaginacao<T>(
  collection: OrmCollection,
  options: PagedQueryOptions,
): Promise<IResponsePaginate<T>> {
  const rows = await applyQueryOptions(collection, options).all();
  if (!rows.length) return emptyPage<T>(options.page ?? 1);
  const data = convertBigIntValues(decodeRowsForCollection(collection, rows)) as T[];
  return buildPage<T>(data, data.length, options.page, undefined);
}

type ConstrutorDeAgregado = { count(): unknown; sum(campo: string): unknown };

/** `count` e as somas pedidas, sobre o filtro inteiro. */
async function fetchResumo(
  collection: OrmCollection,
  where: unknown,
  sum: readonly string[],
): Promise<ResumoDaListagem> {
  const result = (await applyWhere(collection, where).aggregate((a: ConstrutorDeAgregado) => ({
    count: a.count(),
    ...Object.fromEntries(sum.map((campo) => [campo, a.sum(campo)])),
  }))) as Record<string, unknown>;
  const toValor = (valor: unknown) =>
    typeof valor === "bigint" ? valor.toString() : (valor ?? null);
  return {
    count: Number(result.count ?? 0),
    sum: Object.fromEntries(sum.map((campo) => [campo, toValor(result[campo])])),
  };
}

/**
 * Listagem paginada: ids da página (só o índice), depois as linhas por id com a projeção,
 * depois a contagem — o mesmo desenho do `executePrismaQuery`, inclusive `deriveTotal` e
 * `countTtlMs`.
 */
export async function executeOrmQuery<T>(
  collection: OrmCollection,
  options: PagedQueryOptions,
): Promise<IResponsePaginate<T>> {
  const page = await executeOrmPage<T>(collection, options);
  return withResumo(page, options.summary, (sum) => fetchResumo(collection, options.where, sum));
}

async function executeOrmPage<T>(
  collection: OrmCollection,
  options: PagedQueryOptions,
): Promise<IResponsePaginate<T>> {
  applyColumnProjection(options);
  if (options.take == null) return executeSemPaginacao<T>(collection, options);
  const filtered = applyWhere(collection, options.where);
  const ordered = applyOrderBy(filtered, options.orderBy);
  return paginar<T>(
    {
      fetchIds: () => applyPage(ordered.select("id"), options.skip, options.take).all(),
      fetchRows: async (ids) => {
        const byId = applyWhere(collection, { id: { in: ids } });
        const rows = await applyProjection(applyOrderBy(byId, options.orderBy), options).all();
        return decodeRowsForCollection(collection, rows);
      },
      fetchCount: () => countRows(filtered),
      cacheModel: collectionMeta(collection).modelName ?? "?",
    },
    options,
  );
}

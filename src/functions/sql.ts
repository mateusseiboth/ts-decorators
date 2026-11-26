import { CacheProvider } from "../decorators/cacheable";
import { prismaModelNameOf } from "../fields/rowFields";
import {
  getCompanyIdInjector,
  type CompanyId,
  type CompanyIdInjector,
} from "../handlers/companyId";
import { getHandlerContext } from "../handlers/context";
import { decodeRowsForCollection, isTemporal, temporalToIso } from "../prisma8/temporal";
import { stableStringify } from "./object";

export interface IResponsePaginate<T> {
  data: {
    data: T[];
    /** Os nomes são o contrato antigo que as telas leem: `totalPage` é o total de REGISTROS e
     * `total` é a quantidade de PÁGINAS. */
    paginacao: {
      totalPage?: number;
      total?: number;
      page?: number;
    };
  };
}

/**
 * Serializa `bigint` (JSON.stringify explode com ele), `Date` e `Temporal` (o que o Prisma 8
 * devolve para coluna de data) do resultado, em profundidade — sempre no mesmo ISO com `Z`.
 *
 * Percorre TODA linha de TODA listagem, então evita alocação: nada de
 * `Object.entries` + `reduce` criando um array de pares por objeto visitado.
 */
export function convertBigIntValues<T>(data: T): T {
  if (typeof data === "bigint") return data.toString() as unknown as T;

  if (Array.isArray(data)) {
    const out = new Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = convertBigIntValues(data[i]);
    return out as unknown as T;
  }

  if (data instanceof Date) {
    return data.toISOString() as unknown as T;
  }

  if (isTemporal(data)) {
    return temporalToIso(data) as unknown as T;
  }

  if (data !== null && typeof data === "object") {
    const out: Record<string, any> = {};
    const keys = Object.keys(data as Record<string, any>);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string;
      const value = (data as Record<string, any>)[key];
      out[key] = typeof value === "bigint" ? value.toString() : convertBigIntValues(value);
    }
    return out as T;
  }

  return data;
}

/**
 * Interseção entre a projeção pedida pelo cliente e o `select` que o chamador já definiu.
 *
 * O `select` do DAO é uma whitelist deliberada (ex.: usuário sem hash de senha), então a
 * projeção só pode ESTREITAR: campo fora dela é descartado, nunca revelado.
 */
function intersectSelect(
  requested: Record<string, any>,
  allowed: Record<string, any>,
): Record<string, any> {
  return Object.entries(requested).reduce(
    (acc, [key, value]) => {
      const permitted = allowed[key];
      if (!permitted) return acc;

      if (permitted === true) {
        acc[key] = value;
        return acc;
      }

      // Relação com restrição própria do DAO (where/orderBy/select): a restrição fica de pé.
      if (value === true) {
        acc[key] = permitted;
        return acc;
      }

      const { include: _dropped, ...constraints } = permitted;
      const nested = permitted.select
        ? intersectSelect(value.select ?? {}, permitted.select)
        : value.select;
      acc[key] = Object.keys(nested ?? {}).length ? { ...constraints, select: nested } : permitted;
      return acc;
    },
    {} as Record<string, any>,
  );
}

/** `distinct` só dedupe de verdade se o campo estiver na projeção. */
function ensureDistinctFields(select: Record<string, any>, distinct: any) {
  if (!distinct) return;
  const fields = Array.isArray(distinct) ? distinct : [distinct];
  fields
    .filter((field) => typeof field === "string" && !select[field])
    .forEach((field) => (select[field] = true));
}

/**
 * Aplica a projeção vinda do `getColumns` (`?fields=id,name`) por cima da query.
 *
 * - Com `select` próprio do chamador → interseção (a projeção só estreita).
 * - Sem `select` próprio → a projeção VIRA o select e o `include` é descartado
 *   (Prisma aceita select XOR include).
 * - Interseção vazia (nada do que foi pedido é exposto pela rota) → mantém a query
 *   original, em vez de mandar um `select` vazio para o Prisma.
 */
export function applyColumnProjection(options: {
  columns?: any;
  select?: any;
  include?: any;
  distinct?: any;
}) {
  const columns = options.columns;
  delete options.columns;
  if (!columns || !Object.keys(columns).length) return;

  const projection = options.select ? intersectSelect(columns, options.select) : { ...columns };
  if (!Object.keys(projection).length) return;

  ensureDistinctFields(projection, options.distinct);
  options.select = projection;
  delete options.include;
}

/** Prefixo das chaves de contagem no `CacheProvider` (cache "flat" do pacote). */
const COUNT_CACHE_PREFIX = "count";

/**
 * Nome do model por trás do delegate do Prisma (`tx.contribuinte` → `"Contribuinte"`).
 * O Prisma expõe isso em qualquer campo de `delegate.fields`.
 */
const modelNameOf = (delegate: unknown): string => prismaModelNameOf(delegate) ?? "?";

/**
 * Chave da contagem. A TENANT entra sempre: a RLS filtra por ela no banco sem
 * aparecer no `where`, então sem isso o total de um município seria servido a outro.
 */
function countCacheKey(model: string, where: unknown): string {
  const ctx = getHandlerContext();
  const entity = ctx?.entity ?? 0;
  return `${COUNT_CACHE_PREFIX}|${model}|ent:${entity}|${stableStringify(where)}`;
}

/**
 * Descarta as contagens memorizadas — chame depois de uma escrita que muda o total.
 * Sem argumento limpa todos os models; com o nome do model, só aquele.
 */
export function invalidateCountCache(model?: string): number {
  return CacheProvider.invalidate(
    model ? `${COUNT_CACHE_PREFIX}|${model}|*` : `${COUNT_CACHE_PREFIX}|*`,
  );
}

/** Liga a dedução do total para o processo inteiro. Default: `false`. */
let _deriveTotalDefault = false;

/**
 * Deduzir o total sem consultar o `count` MUDA o comportamento observável: a
 * consulta some. Biblioteca compartilhada não troca isso por baixo de quem já
 * depende dela, então nasce desligada — ligue por chamada (`deriveTotal: true`)
 * ou aqui, uma vez, no bootstrap do projeto.
 */
export function setDeriveTotalDefault(enabled: boolean): void {
  _deriveTotalDefault = enabled;
}

export function getDeriveTotalDefault(): boolean {
  return _deriveTotalDefault;
}

/**
 * Quantos registros existem no total, SEM ir ao banco quando a resposta já conta a história.
 *
 * A página trouxe menos linhas que o `take` pedido? Então ela é a última: o total é o
 * deslocamento mais o que veio. Sem `take`? Trouxemos tudo. Só a página CHEIA deixa dúvida
 * — aí sim vale o `count`, que numa tabela grande costuma ser a consulta mais cara das três.
 */
function deriveTotalFromPage(rows: number, skip: number | undefined, take: number | undefined) {
  if (take != null && rows >= take) return undefined; // pode haver mais: precisa contar
  return (skip ?? 0) + rows;
}

export interface PaginateOptions {
  skip?: number;
  take?: number;
  page?: number;
  where?: unknown;
  /** Deduz o total quando a página responde sozinha, poupando o `count`. */
  deriveTotal?: boolean;
  /** Reaproveita a contagem entre páginas da mesma listagem, por N ms. */
  countTtlMs?: number;
}

/** As três idas ao banco de uma listagem, abstraídas do client (Prisma 7 ou 8). */
export interface PaginateSources {
  fetchIds(): PromiseLike<Array<{ id: unknown }>>;
  fetchRows(ids: unknown[]): PromiseLike<unknown>;
  fetchCount(): PromiseLike<number>;
  /** Nome do model para a chave do cache de contagem. */
  cacheModel: string;
}

/** O envelope de toda listagem: `{ data: { data, paginacao } }`, com linhas ou sem. */
export function buildPage<T>(
  rows: T[],
  count: number,
  page: number | undefined,
  take: number | undefined,
): IResponsePaginate<T> {
  return {
    data: {
      data: rows,
      paginacao: { totalPage: count, page, total: Math.ceil(count / (take || 10)) },
    },
  };
}

/** Listagem sem nenhum registro, no MESMO envelope da cheia (quem lê `data.data` recebe `[]`). */
export function emptyPage<T>(page: number = 1): IResponsePaginate<T> {
  return buildPage<T>([], 0, page, undefined);
}

/**
 * A página veio sem linhas. Na primeira, o total é zero com certeza e não há o que contar. Depois
 * dela (página além da última, link antigo, último item excluído), a coleção pode ter registros:
 * a contagem diz quantos, para a tela mostrar o paginador certo e voltar para uma página que existe.
 */
async function buildEmptyPage<T>(
  sources: PaginateSources,
  options: PaginateOptions,
): Promise<IResponsePaginate<T>> {
  if (!options.skip) return emptyPage<T>(options.page ?? 1);
  const cacheKey = options.countTtlMs ? countCacheKey(sources.cacheModel, options.where) : "";
  const cached = cacheKey ? CacheProvider.get<number>(cacheKey) : undefined;
  const count = cached ?? (await sources.fetchCount());
  if (cacheKey) CacheProvider.add(cacheKey, count, options.countTtlMs);
  return buildPage<T>([], count, options.page, options.take);
}

/**
 * Núcleo da listagem paginada, compartilhado por `executePrismaQuery` (Prisma 7) e
 * `executeOrmQuery` (Prisma 8): ids da página, linhas por id, contagem — e a resposta
 * `{ data: { data, paginacao } }` que toda tela já lê.
 */
export async function paginar<T>(
  sources: PaginateSources,
  options: PaginateOptions,
): Promise<IResponsePaginate<T>> {
  const countTtlMs = options.countTtlMs;
  const deriveTotal = options.deriveTotal ?? _deriveTotalDefault;
  const page = options.page;
  const take = options.take;

  // 1ª ida ao banco: só as PKs. Percorre o índice, sem carregar coluna nenhuma.
  const ids = await sources.fetchIds();
  if (!ids.length) return buildEmptyPage<T>(sources, options);

  const readLinhas = () => sources.fetchRows(ids.map((i) => i.id));

  // Caminho HISTÓRICO, e o padrão: as linhas e DEPOIS a contagem, em sequência,
  // sempre. Só quem pede a otimização recebe o comportamento novo.
  const [data, count] =
    deriveTotal || countTtlMs != null
      ? await runOptimized(sources, options, ids, readLinhas, deriveTotal, countTtlMs)
      : [await readLinhas(), await sources.fetchCount()];

  return buildPage<T>(convertBigIntValues(data) as T[], count, page, take);
}

export async function executePrismaQuery<T>(
  objectPrismaQuery: any,
  options: any & {
    skip?: number;
    take?: number;
    page?: number;
    where?: any;
    include?: any;
    distinct?: any;
    select?: any;
    columns?: any;
    /** Deduz o total quando a página responde sozinha, poupando o `count`. */
    deriveTotal?: boolean;
    /** Reaproveita a contagem entre páginas da mesma listagem, por N ms. */
    countTtlMs?: number;
  },
): Promise<IResponsePaginate<T>> {
  applyColumnProjection(options);

  const paginateOptions: PaginateOptions = {
    skip: options.skip,
    take: options.take,
    page: options.page,
    where: options.where,
    deriveTotal: options.deriveTotal,
    countTtlMs: options.countTtlMs,
  };
  delete options.countTtlMs;
  delete options.deriveTotal;
  delete options.page;

  const result = await paginar<T>(
    {
      fetchIds: () =>
        objectPrismaQuery.findMany({
          where: options.where,
          select: { id: true },
          orderBy: options.orderBy,
          skip: options.skip,
          take: options.take,
        }),
      // A linha vira o dado da API pelo caminho único de leitura (campo cifrado decifrado).
      fetchRows: async (ids) =>
        decodeRowsForCollection(
          objectPrismaQuery,
          await objectPrismaQuery.findMany({
            where: { id: { in: ids } },
            orderBy: options.orderBy,
            include: options.include,
            distinct: options.distinct,
            select: options.select,
          }),
        ),
      fetchCount: () => objectPrismaQuery.count({ where: options.where }),
      cacheModel: modelNameOf(objectPrismaQuery),
    },
    paginateOptions,
  );

  delete options.skip;
  delete options.take;
  delete options.include;
  return result;
}

/**
 * Caminho otimizado, só sob pedido.
 *
 * A contagem é a mais cara das três consultas (numa tabela de 28 mil linhas,
 * ~8ms de ~11ms). Três saídas, da mais barata para a mais cara: deduzir da
 * própria página, reaproveitar a contagem da página anterior, ou ir ao banco —
 * e, nesse caso, junto das linhas em vez de esperar por elas.
 */
async function runOptimized(
  sources: PaginateSources,
  options: PaginateOptions,
  ids: unknown[],
  readLinhas: () => PromiseLike<unknown>,
  deriveTotal: boolean,
  countTtlMs: number | undefined,
): Promise<[unknown, number]> {
  const cacheKey = countTtlMs ? countCacheKey(sources.cacheModel, options.where) : "";
  const known =
    (deriveTotal ? deriveTotalFromPage(ids.length, options.skip, options.take) : undefined) ??
    (cacheKey ? CacheProvider.get<number>(cacheKey) : undefined);

  const [data, count] = await Promise.all([readLinhas(), known ?? sources.fetchCount()]);

  // O total vale para as PRÓXIMAS páginas da mesma listagem — o filtro não mudou.
  if (cacheKey) CacheProvider.add(cacheKey, count, countTtlMs);

  return [data, count];
}

/**
 * Fixa o tenant da RLS na transação, seja ela do Prisma 7 (`$executeRawUnsafe`) ou do Prisma 8
 * (plano cru via `configurePrisma8`).
 *
 * Padrão: `SELECT set_config('my.company_id', $1, true)`, com o id como parâmetro.
 * Troque globalmente com `setCompanyIdInjector(fn)` ou pontualmente passando `injector` no
 * terceiro parâmetro.
 */
export function addCompanyIdToTransaction(
  tx: any,
  companyId: CompanyId,
  injector?: CompanyIdInjector,
): unknown {
  return (injector ?? getCompanyIdInjector())(tx, companyId);
}

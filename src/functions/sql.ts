import { getCompanyIdInjector, type CompanyIdInjector } from "../handlers/companyId";
import { getHandlerContext } from "../handlers/context";
import { stableStringify } from "./object";

export interface IResponsePaginate<T> {
  data: {
    data: T[];
    paginacao: {
      total?: number;
      page?: number;
    };
  };
}

/**
 * Serializa `bigint` (JSON.stringify explode com ele) e `Date` do resultado do
 * Prisma, em profundidade.
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

interface CountEntry {
  count: number;
  expiresAt: number;
}

/** Contagens memorizadas por model + entidade + filtro. */
const _countCache = new Map<string, CountEntry>();

/**
 * Nome do model por trás do delegate do Prisma (`tx.contribuinte` → `"Contribuinte"`).
 * O Prisma expõe isso em qualquer campo de `delegate.fields`.
 */
function modelNameOf(delegate: any): string {
  const fields = delegate?.fields;
  if (!fields) return "?";
  for (const key of Object.keys(fields)) {
    const modelName = fields[key]?.modelName;
    if (typeof modelName === "string") return modelName;
  }
  return "?";
}

/**
 * Chave da contagem. A ENTIDADE entra sempre: a RLS filtra por ela no banco sem
 * aparecer no `where`, então sem isso o total de um município seria servido a outro.
 */
function countCacheKey(delegate: any, where: any): string {
  const entity = getHandlerContext()?.entity ?? 0;
  return `${modelNameOf(delegate)}|ent:${entity}|${stableStringify(where)}`;
}

function readCount(key: string): number | undefined {
  const entry = _countCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    _countCache.delete(key);
    return undefined;
  }
  return entry.count;
}

/**
 * Descarta as contagens memorizadas — chame depois de uma escrita que muda o total.
 * Sem argumento limpa todos os models; com o nome do model, só aquele.
 */
export function invalidateCountCache(model?: string): number {
  if (model == null) {
    const total = _countCache.size;
    _countCache.clear();
    return total;
  }
  const prefix = `${model}|`;
  let removed = 0;
  for (const key of _countCache.keys()) {
    if (key.startsWith(prefix)) {
      _countCache.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Quantos registros existem no total, SEM ir ao banco quando a resposta já conta a história.
 *
 * A página trouxe menos linhas que o `take` pedido? Então ela é a última: o total é o
 * deslocamento mais o que veio. Sem `take`? Trouxemos tudo. Só a página CHEIA deixa dúvida
 * — aí sim vale o `count`, que numa tabela grande costuma ser a consulta mais cara das três.
 */
function deriveTotal(rows: number, skip: number | undefined, take: number | undefined) {
  if (take != null && rows >= take) return undefined; // pode haver mais: precisa contar
  return (skip ?? 0) + rows;
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
    countTtlMs?: number;
  },
): Promise<IResponsePaginate<T>> {
  const countTtlMs = options.countTtlMs;
  delete options.countTtlMs;

  const paginate = {
    count: 0,
    page: options.page,
    take: options.take,
  };
  delete options.page;

  // 1ª ida ao banco: só as PKs. Percorre o índice, sem carregar coluna nenhuma.
  const ids = await objectPrismaQuery.findMany({
    where: options.where,
    select: { id: true },
    orderBy: options.orderBy,
    skip: options.skip,
    take: options.take,
  });

  if (!ids.length) {
    return {
      data: [] as any,
      paginate: { totalPage: 0, page: 1, total: 0 },
    } as any;
  }

  // Contagem: a mais cara das três consultas (numa tabela de 28 mil linhas, ~8ms de
  // ~11ms). Três saídas, da mais barata para a mais cara: deduzir da própria página,
  // reaproveitar a contagem da página anterior, ou ir ao banco.
  const cacheKey = countTtlMs ? countCacheKey(objectPrismaQuery, options.where) : "";
  const derived =
    deriveTotal(ids.length, options.skip, options.take) ??
    (cacheKey ? readCount(cacheKey) : undefined);

  // 2ª ida: as linhas e, quando ainda for preciso, a contagem — DISPARADAS JUNTAS.
  // Uma não depende da outra; esperar a primeira para só então pedir a segunda gastava
  // uma viagem de rede a mais em toda listagem.
  const [data, count] = await Promise.all([
    objectPrismaQuery.findMany({
      where: {
        id: { in: ids.map((i: any) => i.id) },
      },
      orderBy: options.orderBy,
      include: options.include,
      distinct: options.distinct,
      select: options.select,
    }),
    derived ?? objectPrismaQuery.count({ where: options.where }),
  ]);

  const treatedDataWithBigIntToString = convertBigIntValues(data);

  delete options.skip;
  delete options.take;
  delete options.include;
  paginate.count = count;

  // O total vale para as PRÓXIMAS páginas da mesma listagem — o filtro não mudou.
  if (cacheKey) _countCache.set(cacheKey, { count, expiresAt: Date.now() + countTtlMs! });

  const responseWithPaginate = {
    data: {
      data: treatedDataWithBigIntToString,
      paginacao: {
        totalPage: paginate.count,
        page: paginate.page,
        total: Math.ceil(paginate.count / (paginate.take || 10)),
      },
    },
  };
  return responseWithPaginate;
}

/**
 * Aplica o company id na transação usando a estratégia configurada.
 *
 * Padrão: `SET LOCAL "my.company_id" = <id>`.
 * Troque globalmente com `setCompanyIdInjector(fn)` ou pontualmente passando
 * `injector` no terceiro parâmetro.
 */
export function addCompanyIdToTransaction(
  tx: any,
  companyId: string,
  injector?: CompanyIdInjector,
) {
  return (injector ?? getCompanyIdInjector())(tx, companyId);
}

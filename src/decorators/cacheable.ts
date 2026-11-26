/**
 * @Cacheable - Decorator para cache em métodos de leitura.
 *
 * Mantém um cache em memória por entidade + chave gerada a partir dos args.
 * O cache é invalidado automaticamente quando métodos de escrita (create, update, deleteById)
 * são chamados na mesma classe.
 *
 * Uso:
 *   @Cacheable({ ttl: 30_000 })  // 30s, aplicado na classe
 *   class MeuController { ... }
 *
 * Ou passando os dois arrays diretamente (funções que CACHEIAM, funções que INVALIDAM):
 *   @Cacheable(["get", "list"], ["create", "update", "deleteById"], { ttl: 30_000 })
 *   class MeuController { ... }
 *
 * Ou por método:
 *   @CacheMethod({ ttl: 60_000 })
 *   async get(req, res) { ... }
 *
 * Para relatórios/funções que retornam dados diretamente (respeitando a RLS via contexto):
 *   @Cached({ tag: "boletim-imovel" })
 *   async gerarBoletim(filtros) { ... return dados }
 *
 * Controle manual do cache:
 *   CacheProvider.add(key, valor, ttlMs?)
 *   CacheProvider.invalidate()          // limpa TODO o cache
 *   CacheProvider.invalidate(key)       // remove uma chave (aceita "prefixo-*")
 */

import { logger } from "../functions/logger";
import { stableStringify } from "../functions/object";
import { getHandlerContext } from "../handlers/context";
import { matchAsync, wrapMetodosDaClasse } from "./_method";
import { isDecoratorContext, warnLegacy } from "./_proxy";

interface CacheEntry {
  data: any;
  expiresAt: number;
}

interface CacheOptions {
  /** TTL em milissegundos. Default: 15_000 (15s) */
  ttl?: number;
  /** Nomes das funções que devem ser CACHEADAS. Default: ["get"] */
  cacheable?: string[];
  /** Nomes das funções que INVALIDAM o cache. Default: ["create", "update", "deleteById"] */
  invalidate?: string[];
  /** @deprecated use `cacheable`. */
  readMethods?: string[];
  /** @deprecated use `invalidate`. */
  writeMethods?: string[];
  /** Tamanho máximo de entradas no cache por entidade. Default: 200 */
  maxEntries?: number;
}

const DEFAULT_CACHEABLE = ["get"];
const DEFAULT_INVALIDATE = ["create", "update", "deleteById"];

const DEFAULT_OPTIONS = {
  ttl: 15_000,
  cacheable: DEFAULT_CACHEABLE,
  invalidate: DEFAULT_INVALIDATE,
  maxEntries: 200,
};

// Cache HTTP separado por className → entidade → cacheKey
const _cache = new Map<string, Map<string, Map<string, CacheEntry>>>();

// Cache "flat" para chaves manuais e de relatórios (CacheProvider / @Cached).
// Ex.: "report-BoletimController-gerarBoletim-boletim-imovel|ent:1|args:{...}"
const _flat = new Map<string, CacheEntry>();

/** Limpa todo o cache (útil para testes) */
export function clearAllCache() {
  _cache.clear();
  _flat.clear();
}

/** Retorna stats do cache para monitoramento */
export function getCacheStats() {
  const stats: Record<string, number> = {};
  for (const [className, tenantMap] of _cache) {
    let total = 0;
    for (const [, entries] of tenantMap) {
      total += entries.size;
    }
    stats[className] = total;
  }
  if (_flat.size) stats["__flat__"] = _flat.size;
  return stats;
}

function getClassCache(className: string): Map<string, Map<string, CacheEntry>> {
  let classCache = _cache.get(className);
  if (!classCache) {
    classCache = new Map();
    _cache.set(className, classCache);
  }
  return classCache;
}

function getTenantCache(className: string, entidade: string): Map<string, CacheEntry> {
  const classCache = getClassCache(className);
  let tenantCache = classCache.get(entidade);
  if (!tenantCache) {
    tenantCache = new Map();
    classCache.set(entidade, tenantCache);
  }
  return tenantCache;
}

function invalidateForTenant(className: string, entidade: string) {
  const classCache = _cache.get(className);
  if (classCache) {
    classCache.delete(entidade);
  }
}

/**
 * Resolve a entidade (RLS) para chavear o cache. A entidade nunca é passada
 * explicitamente: vem do `res.locals` ou do contexto (AsyncLocalStorage).
 */
function resolveTenant(res?: any): string {
  const fromLocals = res?.locals?.entity ?? res?.locals?.entidade;
  if (fromLocals != null) return String(fromLocals);
  const ctx = getHandlerContext();
  if (ctx?.entity != null) return String(ctx.entity);
  return "0";
}

function buildCacheKey(req: any, res?: any): string {
  const parts: string[] = [
    req.method || "GET",
    req.baseUrl || "",
    req.path || req.originalUrl || req.url || "",
  ];
  if (req.params && Object.keys(req.params).length) {
    parts.push("p:" + stableStringify(req.params));
  }
  if (req.query && Object.keys(req.query).length) {
    parts.push("q:" + stableStringify(req.query));
  }
  // Headers de paginação/ordenação que o frontend envia
  if (req.headers) {
    const { paginate, page, offset, orderby, ordermethod, entity, entidade, exercicio } =
      req.headers;
    if (paginate) parts.push("pg:" + paginate);
    if (page) parts.push("page:" + page);
    if (offset) parts.push("off:" + offset);
    if (orderby) parts.push("ob:" + orderby);
    if (ordermethod) parts.push("om:" + ordermethod);
    if (entity || entidade) parts.push("ent:" + (entity || entidade));
    if (exercicio) parts.push("ex:" + exercicio);
  }
  // Valores parseados pelos middlewares (where, orderBy, paginate, columns)
  if (res?.locals) {
    const { where, orderBy, paginate, columns } = res.locals;
    if (where && Object.keys(where).length) parts.push("w:" + stableStringify(where));
    if (orderBy && (Array.isArray(orderBy) ? orderBy.length : Object.keys(orderBy).length))
      parts.push("o:" + stableStringify(orderBy));
    if (paginate) parts.push("pag:" + stableStringify(paginate));
    // Projeção do getColumns: respostas com ?fields= diferentes NÃO podem compartilhar cache.
    if (columns && Object.keys(columns).length) parts.push("c:" + stableStringify(columns));
  }
  return parts.join("|");
}

/**
 * Grava a resposta no cache, varrendo o mapa SÓ quando ele passa do limite.
 *
 * A varredura por expirados acontecia a cada MISS — isto é, a cada requisição
 * não cacheada percorríamos as 200 entradas da entidade. Agora ela só entra em
 * cena quando o mapa realmente cresceu além do teto, e a limpeza por expiração
 * já é feita na leitura (entrada vencida é tratada como ausente).
 */
function storeEntry(
  tenantCache: Map<string, CacheEntry>,
  cacheKey: string,
  entry: CacheEntry,
  maxEntries: number,
) {
  tenantCache.set(cacheKey, entry);
  if (tenantCache.size <= maxEntries) return;

  const now = Date.now();
  for (const [key, cached] of tenantCache) {
    if (cached.expiresAt < now) tenantCache.delete(key);
  }

  // Ainda cheio depois de expurgar os vencidos: descarta os mais antigos
  // (ordem de inserção do Map).
  let excess = tenantCache.size - maxEntries;
  if (excess <= 0) return;
  for (const key of tenantCache.keys()) {
    if (excess-- <= 0) break;
    tenantCache.delete(key);
  }
}

/**
 * Decorator de classe. As funções que cacheiam e as que invalidam vêm no
 * próprio objeto de options, via `cacheable` e `invalidate`:
 *
 *   @Cacheable({ ttl: 30_000, cacheable: ["get", "list"], invalidate: ["create", "update"] })
 */
const MARCA_CACHEABLE = Symbol("ts-decorators:cacheable");

export function Cacheable(options: CacheOptions = {}) {
  const opts = {
    ttl: options.ttl ?? DEFAULT_OPTIONS.ttl,
    maxEntries: options.maxEntries ?? DEFAULT_OPTIONS.maxEntries,
    cacheable: options.cacheable ?? options.readMethods ?? DEFAULT_CACHEABLE,
    invalidate: options.invalidate ?? options.writeMethods ?? DEFAULT_INVALIDATE,
  };

  return function <T extends { new (...args: any[]): any }>(
    constructor: T,
    context?: ClassDecoratorContext,
  ): T {
    if (!context || !isDecoratorContext(context)) {
      warnLegacy("Cacheable");
    }
    const className = constructor.name;

    // Funções que cacheiam: retornam do cache se disponível.
    const buildCacheado = (methodName: string, originalMethod: Function): Function =>
      async function (this: any, req: any, res: any, ...rest: any[]) {
        const entidade = resolveTenant(res);
        const cacheKey = buildCacheKey(req, res);
        const tenantCache = getTenantCache(className, entidade);

        // Verifica cache
        const cached = tenantCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          logger.debug(
            () =>
              `[@mateusseiboth/ts-decorators] Cache HIT ${className}.${methodName} (entidade: ${entidade})`,
          );
          res.setHeader("X-Cache", "HIT");
          return res.status(200).json(cached.data);
        }

        // Intercepta res.json para capturar resposta
        const originalJson = res.json.bind(res);
        res.json = function (body: any) {
          // Grava no cache apenas se status 2xx
          if (res.statusCode >= 200 && res.statusCode < 300) {
            storeEntry(
              tenantCache,
              cacheKey,
              { data: body, expiresAt: Date.now() + opts.ttl },
              opts.maxEntries,
            );
          }
          res.setHeader("X-Cache", "MISS");
          return originalJson(body);
        };

        return originalMethod.call(this, req, res, ...rest);
      };

    // Funções que invalidam: limpam o cache da entidade APENAS em caso de sucesso.
    const buildInvalidador = (originalMethod: Function): Function =>
      async function (this: any, req: any, res: any, ...rest: any[]) {
        let succeeded = false;
        try {
          const result = await originalMethod.call(this, req, res, ...rest);
          succeeded = true;
          return result;
        } finally {
          // Só invalida quando a função terminou com sucesso; em erro, mantém o cache.
          if (succeeded) {
            const entidade = resolveTenant(res);
            invalidateForTenant(className, entidade);
          }
        }
      };

    // Os métodos herdados da classe base entram: o `get` do controller base também é guardado.
    wrapMetodosDaClasse(constructor, MARCA_CACHEABLE, ({ name, original }) => {
      const cacheado = opts.cacheable.includes(name) ? buildCacheado(name, original) : original;
      const final = opts.invalidate.includes(name) ? buildInvalidador(cacheado) : cacheado;
      return final === original ? undefined : final;
    });

    return constructor;
  };
}

/**
 * Decorator de método individual: permite TTL customizado por método.
 */
export function CacheMethod(options?: { ttl?: number }) {
  const ttl = options?.ttl || DEFAULT_OPTIONS.ttl;

  return function (...args: any[]): any {
    // New TC39 method decorator: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const originalMethod = args[0] as Function;
      const methodKey = String(args[1].name);
      return async function (this: any, req: any, res: any, ...rest: any[]) {
        const className = this.constructor.name;
        const entidade = resolveTenant(res);
        const cacheKey = `${methodKey}:${buildCacheKey(req, res)}`;
        const tenantCache = getTenantCache(className, entidade);

        const cached = tenantCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          logger.debug(
            () =>
              `[@mateusseiboth/ts-decorators] Cache HIT ${className}.${methodKey} (entidade: ${entidade})`,
          );
          res.setHeader("X-Cache", "HIT");
          return res.status(200).json(cached.data);
        }

        const originalJson = res.json.bind(res);
        res.json = function (body: any) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            storeEntry(
              tenantCache,
              cacheKey,
              { data: body, expiresAt: Date.now() + ttl },
              DEFAULT_OPTIONS.maxEntries,
            );
          }
          res.setHeader("X-Cache", "MISS");
          return originalJson(body);
        };

        return originalMethod.call(this, req, res, ...rest);
      };
    }

    // Legacy method decorator: (target, propertyKey, descriptor)
    warnLegacy("CacheMethod");
    const _target = args[0];
    const propertyKey = args[1] as string;
    const descriptor = args[2] as PropertyDescriptor;
    const originalMethod = descriptor.value;
    const methodKey = propertyKey;

    descriptor.value = async function (this: any, req: any, res: any, ...rest: any[]) {
      const className = this.constructor.name;
      const entidade = resolveTenant(res);
      const cacheKey = `${methodKey}:${buildCacheKey(req, res)}`;
      const tenantCache = getTenantCache(className, entidade);

      const cached = tenantCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        logger.debug(
          () =>
            `[@mateusseiboth/ts-decorators] Cache HIT ${className}.${methodKey} (entidade: ${entidade})`,
        );
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(cached.data);
      }

      const originalJson = res.json.bind(res);
      res.json = function (body: any) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          storeEntry(
            tenantCache,
            cacheKey,
            { data: body, expiresAt: Date.now() + ttl },
            DEFAULT_OPTIONS.maxEntries,
          );
        }
        res.setHeader("X-Cache", "MISS");
        return originalJson(body);
      };

      return originalMethod.call(this, req, res, ...rest);
    };
  };
}

// ---------------------------------------------------------------------------
// CacheProvider: controle manual do cache "flat" (chaves de relatórios/manuais)
// ---------------------------------------------------------------------------

/** Monta a chave padronizada de relatório: `report-<Classe>-<funcao>-<tag>[|extras]`. */
export function reportCacheKey(
  className: string,
  method: string,
  tag?: string,
  ...extra: string[]
): string {
  const base = ["report", className, method, tag].filter((p) => p != null && p !== "").join("-");
  return extra.length ? [base, ...extra].join("|") : base;
}

export const CacheProvider = {
  /** Adiciona/atualiza manualmente uma chave de cache. `ttlMs` default: 15s. */
  add(key: string, value: any, ttlMs: number = DEFAULT_OPTIONS.ttl): void {
    _flat.set(key, { data: value, expiresAt: Date.now() + ttlMs });
  },

  /** Retorna o valor cacheado (respeitando expiração) ou `undefined`. */
  get<T = any>(key: string): T | undefined {
    const entry = _flat.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      _flat.delete(key);
      return undefined;
    }
    return entry.data as T;
  },

  /** Indica se existe uma entrada válida para a chave. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  },

  /**
   * Remove cache.
   * - Sem parâmetro: limpa TODO o cache (HTTP + flat) — assinatura original.
   * - Com chave exata: remove aquela entrada.
   * - Com sufixo `*`: remove todas as chaves com aquele prefixo (útil para a "árvore" de relatórios).
   */
  invalidate(key?: string): number {
    if (key == null) {
      const total = _flat.size + _cache.size;
      clearAllCache();
      return total;
    }
    if (key.endsWith("*")) {
      const prefix = key.slice(0, -1);
      let removed = 0;
      for (const k of _flat.keys()) {
        if (k.startsWith(prefix)) {
          _flat.delete(k);
          removed++;
        }
      }
      return removed;
    }
    return _flat.delete(key) ? 1 : 0;
  },

  /** Lista as chaves do cache flat, opcionalmente filtrando por prefixo (para montar a árvore). */
  keys(prefix?: string): string[] {
    const all = [..._flat.keys()];
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  },
};

// ---------------------------------------------------------------------------
// @Cached: cacheia o VALOR DE RETORNO de funções (relatórios e seus filtros).
// Respeita a RLS (entidade vem do contexto, nunca é passada como argumento).
// ---------------------------------------------------------------------------

interface CachedOptions {
  /** TTL em milissegundos. Default: 15_000 (15s) */
  ttl?: number;
  /** Tag do relatório, compõe a chave: `report-<Classe>-<funcao>-<tag>`. */
  tag?: string;
  /** Gera um sufixo custom da chave a partir dos argumentos. Default: stableStringify(args). */
  key?: (...args: any[]) => string;
}

function runCached(
  this: any,
  originalMethod: Function,
  className: string,
  methodKey: string,
  opts: CachedOptions,
  args: any[],
) {
  const entidade = resolveTenant();
  const argKey = opts.key ? opts.key(...args) : stableStringify(args);
  const cacheKey = reportCacheKey(
    className,
    methodKey,
    opts.tag,
    `ent:${entidade}`,
    `args:${argKey}`,
  );

  const cached = CacheProvider.get(cacheKey);
  if (cached !== undefined) {
    logger.debug(() => `[@mateusseiboth/ts-decorators] Cache HIT (report) ${cacheKey}`);
    return cached;
  }

  const result = originalMethod.apply(this, args);
  const ttl = opts.ttl ?? DEFAULT_OPTIONS.ttl;
  if (result && typeof result.then === "function") {
    return result.then((resolved: any) => {
      CacheProvider.add(cacheKey, resolved, ttl);
      return resolved;
    });
  }
  CacheProvider.add(cacheKey, result, ttl);
  return result;
}

/**
 * Decorator de método para relatórios/consultas que retornam dados diretamente.
 *
 *   @Cached({ tag: "boletim-imovel", ttl: 60_000 })
 *   async gerarBoletim(filtros) { return this.dao.query(filtros); }
 *
 * A chave gerada segue o padrão `report-<Classe>-<funcao>-<tag>|ent:<entidade>|args:<...>`,
 * permitindo invalidação manual e a construção de uma árvore de dependências:
 *
 *   CacheProvider.invalidate("report-BoletimController-gerarBoletim-*");
 */
export function Cached(options?: CachedOptions) {
  const opts = options ?? {};

  return function (...args: any[]): any {
    // TC39 Stage 3: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const originalMethod = args[0] as Function;
      const methodKey = String(args[1].name);
      return matchAsync(originalMethod, function (this: any, ...callArgs: any[]) {
        const className = this?.constructor?.name ?? "Fn";
        return runCached.call(this, originalMethod, className, methodKey, opts, callArgs);
      });
    }

    // Legacy: (target, propertyKey, descriptor)
    warnLegacy("Cached");
    const propertyKey = args[1] as string;
    const descriptor = args[2] as PropertyDescriptor;
    const originalMethod = descriptor.value;
    descriptor.value = matchAsync(originalMethod, function (this: any, ...callArgs: any[]) {
      const className = this?.constructor?.name ?? "Fn";
      return runCached.call(this, originalMethod, className, propertyKey, opts, callArgs);
    });
    return descriptor;
  };
}

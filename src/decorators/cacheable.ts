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
 * Ou por método:
 *   @CacheMethod({ ttl: 60_000 })
 *   async get(req, res) { ... }
 *
 */

import {isDecoratorContext, warnLegacy} from "./_proxy";

interface CacheEntry {
  data: any;
  expiresAt: number;
}

interface CacheOptions {
  /** TTL em milissegundos. Default: 15_000 (15s) */
  ttl?: number;
  /** Métodos de leitura que devem ser cacheados. Default: ["get"] */
  readMethods?: string[];
  /** Métodos de escrita que invalidam o cache. Default: ["create", "update", "deleteById"] */
  writeMethods?: string[];
  /** Tamanho máximo de entradas no cache por entidade. Default: 200 */
  maxEntries?: number;
}

const DEFAULT_OPTIONS: Required<CacheOptions> = {
  ttl: 15_000,
  readMethods: ["get"],
  writeMethods: ["create", "update", "deleteById"],
  maxEntries: 200,
};

// Cache global separado por className → entidade → cacheKey
const _cache = new Map<string, Map<string, Map<string, CacheEntry>>>();

/** Limpa todo o cache (útil para testes) */
export function clearAllCache() {
  _cache.clear();
}

/** Retorna stats do cache para monitoramento */
export function getCacheStats() {
  const stats: Record<string, number> = {};
  for (const [className, entidadeMap] of _cache) {
    let total = 0;
    for (const [, entries] of entidadeMap) {
      total += entries.size;
    }
    stats[className] = total;
  }
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

function getEntidadeCache(className: string, entidade: string): Map<string, CacheEntry> {
  const classCache = getClassCache(className);
  let entidadeCache = classCache.get(entidade);
  if (!entidadeCache) {
    entidadeCache = new Map();
    classCache.set(entidade, entidadeCache);
  }
  return entidadeCache;
}

function invalidateForEntidade(className: string, entidade: string) {
  const classCache = _cache.get(className);
  if (classCache) {
    classCache.delete(entidade);
  }
}

function stableStringify(obj: any): string {
  if (!obj || typeof obj !== "object") return String(obj ?? "");
  const sorted = Object.keys(obj)
    .sort()
    .reduce((acc: any, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

function buildCacheKey(req: any, res?: any): string {
  const parts: string[] = [req.method || "GET", req.baseUrl || "", req.path || req.originalUrl || req.url || ""];
  if (req.params && Object.keys(req.params).length) {
    parts.push("p:" + stableStringify(req.params));
  }
  if (req.query && Object.keys(req.query).length) {
    parts.push("q:" + stableStringify(req.query));
  }
  // Headers de paginação/ordenação que o frontend envia
  if (req.headers) {
    const {paginate, page, offset, orderby, ordermethod, entity, entidade, exercicio} = req.headers;
    if (paginate) parts.push("pg:" + paginate);
    if (page) parts.push("page:" + page);
    if (offset) parts.push("off:" + offset);
    if (orderby) parts.push("ob:" + orderby);
    if (ordermethod) parts.push("om:" + ordermethod);
    if (entity || entidade) parts.push("ent:" + (entity || entidade));
    if (exercicio) parts.push("ex:" + exercicio);
  }
  // Valores parseados pelos middlewares (where, orderBy, paginate)
  if (res?.locals) {
    const {where, orderBy, paginate} = res.locals;
    if (where && Object.keys(where).length) parts.push("w:" + stableStringify(where));
    if (orderBy && (Array.isArray(orderBy) ? orderBy.length : Object.keys(orderBy).length)) parts.push("o:" + stableStringify(orderBy));
    if (paginate) parts.push("pag:" + stableStringify(paginate));
  }
  return parts.join("|");
}

function evictExpired(entidadeCache: Map<string, CacheEntry>) {
  const now = Date.now();
  for (const [key, entry] of entidadeCache) {
    if (entry.expiresAt < now) {
      entidadeCache.delete(key);
    }
  }
}

function enforceMaxEntries(entidadeCache: Map<string, CacheEntry>, maxEntries: number) {
  if (entidadeCache.size <= maxEntries) return;
  // Remove as entradas mais antigas (primeiras no Map)
  const toDelete = entidadeCache.size - maxEntries;
  let count = 0;
  for (const key of entidadeCache.keys()) {
    if (count >= toDelete) break;
    entidadeCache.delete(key);
    count++;
  }
}

/**
 * Decorator de classe: aplica cache em métodos de leitura e invalidação nos de escrita.
 */
export function Cacheable(options?: CacheOptions) {
  const opts = {...DEFAULT_OPTIONS, ...options};

  return function <T extends {new (...args: any[]): any}>(constructor: T, context?: ClassDecoratorContext): T {
    if (!context || !isDecoratorContext(context)) {
      warnLegacy("Cacheable");
    }
    const className = constructor.name;

    for (const methodName of Object.getOwnPropertyNames(constructor.prototype)) {
      if (methodName === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, methodName);
      if (!descriptor || typeof descriptor.value !== "function") continue;

      // Métodos de leitura: retorna do cache se disponível
      if (opts.readMethods.includes(methodName)) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (this: any, req: any, res: any, ...rest: any[]) {
          const entidade = String(res.locals?.entity || "0");
          const cacheKey = buildCacheKey(req, res);
          const entidadeCache = getEntidadeCache(className, entidade);

          // Verifica cache
          const cached = entidadeCache.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            console.log(`[@mateusseiboth/ts-commons] Cache HIT ${className}.${methodName} (entidade: ${entidade})`);
            res.setHeader("X-Cache", "HIT");
            return res.status(200).json(cached.data);
          }

          // Intercepta res.json para capturar resposta
          const originalJson = res.json.bind(res);
          res.json = function (body: any) {
            // Grava no cache apenas se status 2xx
            if (res.statusCode >= 200 && res.statusCode < 300) {
              evictExpired(entidadeCache);
              entidadeCache.set(cacheKey, {
                data: body,
                expiresAt: Date.now() + opts.ttl,
              });
              enforceMaxEntries(entidadeCache, opts.maxEntries);
            }
            res.setHeader("X-Cache", "MISS");
            return originalJson(body);
          };

          return originalMethod.call(this, req, res, ...rest);
        };

        Object.defineProperty(constructor.prototype, methodName, descriptor);
      }

      // Métodos de escrita: invalidam cache da entidade
      if (opts.writeMethods.includes(methodName)) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (this: any, req: any, res: any, ...rest: any[]) {
          const result = await originalMethod.call(this, req, res, ...rest);
          const entidade = String(res.locals?.entity || "0");
          invalidateForEntidade(className, entidade);
          return result;
        };

        Object.defineProperty(constructor.prototype, methodName, descriptor);
      }
    }

    return constructor;
  };
}

/**
 * Decorator de método individual: permite TTL customizado por método.
 */
export function CacheMethod(options?: {ttl?: number}) {
  const ttl = options?.ttl || DEFAULT_OPTIONS.ttl;

  return function (...args: any[]): any {
    // New TC39 method decorator: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const originalMethod = args[0] as Function;
      const methodKey = String(args[1].name);
      return async function (this: any, req: any, res: any, ...rest: any[]) {
        const className = this.constructor.name;
        const entidade = String(res.locals?.entity || "0");
        const cacheKey = `${methodKey}:${buildCacheKey(req, res)}`;
        const entidadeCache = getEntidadeCache(className, entidade);

        const cached = entidadeCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          console.log(`[@mateusseiboth/ts-commons] Cache HIT ${className}.${methodKey} (entidade: ${entidade})`);
          res.setHeader("X-Cache", "HIT");
          return res.status(200).json(cached.data);
        }

        const originalJson = res.json.bind(res);
        res.json = function (body: any) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            evictExpired(entidadeCache);
            entidadeCache.set(cacheKey, {
              data: body,
              expiresAt: Date.now() + ttl,
            });
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
      const entidade = String(res.locals?.entity || "0");
      const cacheKey = `${methodKey}:${buildCacheKey(req, res)}`;
      const entidadeCache = getEntidadeCache(className, entidade);

      const cached = entidadeCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        console.log(`[@mateusseiboth/ts-commons] Cache HIT ${className}.${methodKey} (entidade: ${entidade})`);
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(cached.data);
      }

      const originalJson = res.json.bind(res);
      res.json = function (body: any) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          evictExpired(entidadeCache);
          entidadeCache.set(cacheKey, {
            data: body,
            expiresAt: Date.now() + ttl,
          });
        }
        res.setHeader("X-Cache", "MISS");
        return originalJson(body);
      };

      return originalMethod.call(this, req, res, ...rest);
    };
  };
}

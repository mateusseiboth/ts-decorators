/**
 * @RateLimit - Decorator para rate limiting em Controllers.
 *
 * Limita a quantidade de requisições por IP + entidade em uma janela de tempo.
 * Usa sliding window counter em memória (sem dependências externas).
 *
 * Uso em classe (aplica a todos os métodos):
 *   @RateLimit({ maxRequests: 100, windowMs: 60_000 })
 *   class MeuController extends BaseController { ... }
 *
 * Uso por método:
 *   @RateLimitMethod({ maxRequests: 10, windowMs: 60_000 })
 *   async create(req, res) { ... }
 *
 * Uso como middleware Express:
 *   router.use(rateLimitMiddleware({ maxRequests: 100, windowMs: 60_000 }));
 *
 */

import type {NextFunction, Request, Response} from "express";
import {isDecoratorContext, warnLegacy} from "./_proxy";

export interface RateLimitOptions {
  /** Número máximo de requisições na janela. Default: 100 */
  maxRequests?: number;
  /** Janela de tempo em ms. Default: 60_000 (1 minuto) */
  windowMs?: number;
  /** Mensagem de erro retornada ao atingir o limite */
  message?: string;
  /** Função para gerar a chave de rate limit. Default: IP + entidade */
  keyGenerator?: (req: Request, res: Response) => string;
}

const DEFAULT_OPTIONS: Required<RateLimitOptions> = {
  maxRequests: 100,
  windowMs: 60_000,
  message: "Limite de requisições excedido. Tente novamente em alguns instantes.",
  keyGenerator: (req: Request, res: Response) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const entidade = res.locals?.entity || "0";
    return `${ip}:${entidade}`;
  },
};

interface WindowEntry {
  count: number;
  resetAt: number;
}

// Store global: scope → key → WindowEntry
const _store = new Map<string, Map<string, WindowEntry>>();

// Limpeza periódica de entradas expiradas (a cada 5 minutos)
let _cleanupInterval: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (_cleanupInterval) return;
  _cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [scope, entries] of _store) {
      for (const [key, entry] of entries) {
        if (entry.resetAt < now) {
          entries.delete(key);
        }
      }
      if (entries.size === 0) {
        _store.delete(scope);
      }
    }
  }, 5 * 60_000);

  // Não impede o processo de sair
  if (_cleanupInterval.unref) _cleanupInterval.unref();
}

function getScopeStore(scope: string): Map<string, WindowEntry> {
  let scopeStore = _store.get(scope);
  if (!scopeStore) {
    scopeStore = new Map();
    _store.set(scope, scopeStore);
  }
  return scopeStore;
}

function checkLimit(
  scope: string,
  key: string,
  maxRequests: number,
  windowMs: number,
): {allowed: boolean; remaining: number; resetAt: number} {
  ensureCleanup();

  const store = getScopeStore(scope);
  const now = Date.now();
  let entry = store.get(key);

  if (!entry || entry.resetAt < now) {
    entry = {count: 0, resetAt: now + windowMs};
    store.set(key, entry);
  }

  entry.count++;

  return {
    allowed: entry.count <= maxRequests,
    remaining: Math.max(0, maxRequests - entry.count),
    resetAt: entry.resetAt,
  };
}

function setRateLimitHeaders(res: Response, result: {remaining: number; resetAt: number}, maxRequests: number) {
  res.setHeader("X-RateLimit-Limit", maxRequests);
  res.setHeader("X-RateLimit-Remaining", result.remaining);
  res.setHeader("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000));
}

/** Limpa o store de rate limit (útil para testes) */
export function clearRateLimitStore() {
  _store.clear();
}

/**
 * Decorator de classe: aplica rate limit a todos os métodos que recebem (req, res).
 */
export function RateLimit(options?: RateLimitOptions) {
  const opts = {...DEFAULT_OPTIONS, ...options};

  return function <T extends {new (...args: any[]): any}>(constructor: T, context?: ClassDecoratorContext): T {
    if (!context || !isDecoratorContext(context)) {
      warnLegacy("RateLimit");
    }
    const className = constructor.name;

    for (const methodName of Object.getOwnPropertyNames(constructor.prototype)) {
      if (methodName === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, methodName);
      if (!descriptor || typeof descriptor.value !== "function") continue;

      const originalMethod = descriptor.value;

      descriptor.value = async function (this: any, req: Request, res: Response, ...rest: any[]) {
        // Verifica se os dois primeiros args são req e res do Express
        if (!req?.method || !res?.status) {
          return originalMethod.call(this, req, res, ...rest);
        }

        const key = opts.keyGenerator(req, res);
        const scope = `${className}.${methodName}`;
        const result = checkLimit(scope, key, opts.maxRequests, opts.windowMs);

        setRateLimitHeaders(res, result, opts.maxRequests);

        if (!result.allowed) {
          const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
          res.setHeader("Retry-After", retryAfter);
          return res.status(429).json({
            message: opts.message,
            code: "RATE_LIMIT_EXCEEDED",
            retryAfter,
          });
        }

        return originalMethod.call(this, req, res, ...rest);
      };

      Object.defineProperty(constructor.prototype, methodName, descriptor);
    }

    return constructor;
  };
}

/**
 * Decorator de método individual: rate limit granular por endpoint.
 */
export function RateLimitMethod(options?: RateLimitOptions) {
  const opts = {...DEFAULT_OPTIONS, ...options};

  return function (...args: any[]) {
    // New TC39 method decorator: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const originalMethod = args[0] as Function;
      const propertyKey = String(args[1].name);
      return async function (this: any, req: Request, res: Response, ...rest: any[]) {
        if (!req?.method || !res?.status) {
          return originalMethod.call(this, req, res, ...rest);
        }

        const className = this.constructor.name;
        const key = opts.keyGenerator(req, res);
        const scope = `${className}.${propertyKey}`;
        const result = checkLimit(scope, key, opts.maxRequests, opts.windowMs);

        setRateLimitHeaders(res, result, opts.maxRequests);

        if (!result.allowed) {
          const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
          res.setHeader("Retry-After", retryAfter);
          return res.status(429).json({
            message: opts.message,
            code: "RATE_LIMIT_EXCEEDED",
            retryAfter,
          });
        }

        return originalMethod.call(this, req, res, ...rest);
      };
    }

    // Legacy method decorator: (target, propertyKey, descriptor)
    warnLegacy("RateLimitMethod");
    const _target = args[0];
    const propertyKey = args[1] as string;
    const descriptor = args[2] as PropertyDescriptor;
    const originalMethod = descriptor.value;

    descriptor.value = async function (this: any, req: Request, res: Response, ...rest: any[]) {
      if (!req?.method || !res?.status) {
        return originalMethod.call(this, req, res, ...rest);
      }

      const className = this.constructor.name;
      const key = opts.keyGenerator(req, res);
      const scope = `${className}.${propertyKey}`;
      const result = checkLimit(scope, key, opts.maxRequests, opts.windowMs);

      setRateLimitHeaders(res, result, opts.maxRequests);

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
        res.setHeader("Retry-After", retryAfter);
        return res.status(429).json({
          message: opts.message,
          code: "RATE_LIMIT_EXCEEDED",
          retryAfter,
        });
      }

      return originalMethod.call(this, req, res, ...rest);
    };
  };
}

/**
 * Middleware Express standalone: para usar direto nas rotas.
 * router.use(rateLimitMiddleware({ maxRequests: 100, windowMs: 60_000 }));
 */
export function rateLimitMiddleware(options?: RateLimitOptions) {
  const opts = {...DEFAULT_OPTIONS, ...options};

  return function (req: Request, res: Response, next: NextFunction) {
    const key = opts.keyGenerator(req, res);
    const scope = `middleware:${req.baseUrl || req.path}`;
    const result = checkLimit(scope, key, opts.maxRequests, opts.windowMs);

    setRateLimitHeaders(res, result, opts.maxRequests);

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
      res.setHeader("Retry-After", retryAfter);
      return res.status(429).json({
        message: opts.message,
        code: "RATE_LIMIT_EXCEEDED",
        retryAfter,
      });
    }

    next();
  };
}

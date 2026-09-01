import type { NextFunction, Request, Response } from "express";

import { logger } from "../functions/logger";

interface CachedResponse {
  status: number;
  body: unknown;
}

interface PendingRequest {
  promise: Promise<CachedResponse>;
  expiresAt: number;
}

const requests = new Map<string, PendingRequest>();

/**
 * A varredura de expirados só liga quando existe chave para expirar.
 *
 * O `setInterval` ficava no topo do módulo: qualquer import do pacote acordava
 * o processo a cada 5s para varrer um Map vazio — inclusive em CLI e testes.
 */
let sweeper: ReturnType<typeof setInterval> | null = null;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of requests) {
      if (value.expiresAt < now) requests.delete(key);
    }
    if (requests.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, 5000);
  // Idempotência pendente não segura o processo de pé.
  sweeper.unref?.();
}

interface Options {
  ttl?: number;
}

export function idempotencyMiddleware(options: Options = {}) {
  const ttl = options.ttl ?? 60_000;

  return async function (req: Request, res: Response, next: NextFunction) {
    const key = req.header("x-idempotency-key");

    if (!key) {
      return res.status(400).json({
        error: "Missing x-idempotency-key",
      });
    }

    const existing = requests.get(key);

    if (existing) {
      logger.debug(() => `Replaying response for idempotency key: ${key}`);
      const cached = await existing.promise;

      return res.status(cached.status).json(cached.body);
    }

    let resolvePromise!: (value: CachedResponse) => void;
    let rejectPromise!: (reason?: unknown) => void;

    const promise = new Promise<CachedResponse>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    requests.set(key, {
      promise,
      expiresAt: Date.now() + ttl,
    });
    ensureSweeper();

    const originalJson = res.json.bind(res);

    let responseBody: unknown;
    let responseStatus = 200;

    res.json = (body: unknown) => {
      responseBody = body;
      responseStatus = res.statusCode;

      resolvePromise({
        status: responseStatus,
        body: responseBody,
      });

      return originalJson(body);
    };

    res.on("finish", () => {
      // caso não tenha chamado res.json
      if (responseBody === undefined) {
        resolvePromise({
          status: res.statusCode,
          body: null,
        });
      }
    });

    res.on("close", () => {
      // conexão morreu antes de responder
      if (!res.writableEnded) {
        requests.delete(key);

        rejectPromise(new Error("Request aborted"));
      }
    });

    try {
      next();
    } catch (err) {
      requests.delete(key);

      rejectPromise(err);

      throw err;
    }
  };
}

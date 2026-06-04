import type {NextFunction, Request, Response} from "express";

interface CachedResponse {
  status: number;
  body: unknown;
}

interface PendingRequest {
  promise: Promise<CachedResponse>;
  expiresAt: number;
}

const requests = new Map<string, PendingRequest>();

setInterval(() => {
  const now = Date.now();

  for (const [key, value] of requests.entries()) {
    if (value.expiresAt < now) {
      requests.delete(key);
    }
  }
}, 5000);

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
      console.log(`Replaying response for idempotency key: ${key}`);
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

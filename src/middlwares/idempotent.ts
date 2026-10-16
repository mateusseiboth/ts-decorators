import type { NextFunction, Request, Response } from "express";

import { logger } from "../functions/logger";
import { getHandlerContext } from "../handlers/context";

interface CachedResponse {
  status: number;
  body: unknown;
}

interface PendingRequest {
  promise: Promise<CachedResponse>;
  expiresAt: number;
  /** Dono da requisição (usuário/entidade) que criou a chave. */
  owner: string;
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
  /**
   * Deriva o "dono" da requisição para isolar chaves entre usuários/empresas.
   * Uma chave criada por um dono só pode ser reproduzida pelo mesmo dono.
   * Default: usa o contexto (user + entidade); como fallback, o header Authorization + entidade.
   */
  identify?: (req: Request) => string;
}

/**
 * Identidade padrão do dono da requisição. Sem isso, qualquer um que obtenha a
 * chave de idempotência de outro usuário receberia a resposta cacheada dele.
 * Prioriza o contexto (AsyncLocalStorage); se indisponível, cai no token + entidade.
 */
function defaultIdentify(req: Request): string {
  const ctx = getHandlerContext();
  if (ctx && (ctx.user != null || ctx.entity != null)) {
    const userId = ctx.user?.id ?? ctx.user?.userId ?? ctx.user?.username ?? "";
    return `u:${userId}|e:${ctx.entity ?? ""}`;
  }
  const auth = req.header("authorization") ?? "";
  const entity = req.header("entity") ?? req.header("entidade") ?? "";
  return `a:${auth}|e:${entity}`;
}

export function idempotencyMiddleware(options: Options = {}) {
  const ttl = options.ttl ?? 60_000;
  const identify = options.identify ?? defaultIdentify;

  return async function (req: Request, res: Response, next: NextFunction) {
    const key = req.header("x-idempotency-key");

    if (!key) {
      return res.status(400).json({
        error: "Missing x-idempotency-key",
      });
    }

    const owner = identify(req);
    const existing = requests.get(key);

    if (existing) {
      // A chave já existe: só reproduz para o MESMO dono. Chave de outro
      // usuário/empresa nunca vaza a resposta — responde 409 Conflict.
      if (existing.owner !== owner) {
        return res.status(409).json({
          error: "Idempotency key conflict",
        });
      }

      logger.debug(`Replaying response for idempotency key: ${key}`);
      const cached = await existing.promise.catch(() => null);

      // A original caiu antes de responder e liberou a chave: o cliente reenvia.
      if (!cached) {
        return res.status(409).json({
          error: "A requisição anterior foi interrompida. Envie novamente.",
        });
      }

      return res.status(cached.status).json(cached.body);
    }

    let resolvePromise!: (value: CachedResponse) => void;
    let rejectPromise!: (reason?: unknown) => void;

    const promise = new Promise<CachedResponse>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Só um replay escuta esta promise. Sem ele, o abort do cliente vira
    // rejeição não tratada e o Bun encerra o processo.
    promise.catch(() => {});

    const pending: PendingRequest = {
      promise,
      expiresAt: Date.now() + ttl,
      owner,
    };

    requests.set(key, pending);
    ensureSweeper();

    /**
     * Erro não é resultado a reproduzir: a requisição não gravou nada. Cacheá-lo
     * trava o cliente até o TTL — ele corrige o formulário, reenvia com a MESMA
     * chave e recebe de volta o erro antigo, agora sem sentido. Só a resposta
     * bem-sucedida é idempotente; a falha volta a ser uma tentativa nova.
     * A comparação de identidade evita apagar a entrada de uma requisição que
     * já tenha reutilizado a chave depois desta.
     */
    const discardWhenErro = (status: number) => {
      if (status < 400) return;
      if (requests.get(key) === pending) requests.delete(key);
    };

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
      discardWhenErro(responseStatus);

      return originalJson(body);
    };

    res.on("finish", () => {
      // caso não tenha chamado res.json
      if (responseBody === undefined) {
        resolvePromise({
          status: res.statusCode,
          body: null,
        });
        discardWhenErro(res.statusCode);
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

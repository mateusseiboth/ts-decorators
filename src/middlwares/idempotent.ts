import { createHash } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

import { logger } from "../functions/logger";
import { getHandlerContext } from "../handlers/context";
import { METRICA } from "../observability/catalog";
import { incrementMetric } from "../observability/metrics";

interface CachedResponse {
  status: number;
  body: unknown;
}

interface PendingRequest {
  promise: Promise<CachedResponse>;
  expiresAt: number;
  /** Dono da requisição (usuário/entidade) que criou a chave. */
  owner: string;
  /** Método, caminho e hash do corpo da requisição que criou a chave. */
  fingerprint: string;
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

/** `required`: escrita sem chave recebe 400. `optional`: escrita sem chave passa sem idempotência. */
export type IdempotencyMode = "required" | "optional";

export interface IdempotencyOptions {
  /** Por quantos milissegundos a chave vale. Default: 60_000. */
  ttl?: number;
  /**
   * Deriva o "dono" da requisição para isolar chaves entre usuários/empresas.
   * Uma chave criada por um dono só pode ser reproduzida pelo mesmo dono.
   * Default: usa o contexto (user + entidade); como fallback, o header Authorization + entidade.
   */
  identify?: (req: Request) => string;
  /** O que fazer com a escrita que chega sem chave. Default: `"required"`. */
  mode?: IdempotencyMode;
  /** Métodos que passam pela idempotência; os demais seguem direto. Default: POST, PUT, PATCH, DELETE. */
  methods?: string[];
}

const DEFAULT_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * Corpos de erro, no padrão `{ message, code }` do pacote. O texto vai para a tela: diz o que
 * fazer. O `code` é o que o desenvolvedor procura.
 */
const ERRO = {
  KEY_REQUIRED: {
    status: 400,
    body: {
      message: "Não foi possível identificar o envio. Atualize a página e tente de novo.",
      code: "IDEMPOTENCY_KEY_REQUIRED",
    },
  },
  KEY_CONFLICT: {
    status: 409,
    body: {
      message: "Este envio pertence a outro usuário. Atualize a página e tente de novo.",
      code: "IDEMPOTENCY_KEY_CONFLICT",
    },
  },
  KEY_REUSED: {
    status: 422,
    body: {
      message: "Este envio já foi feito com outros dados. Atualize a página e tente de novo.",
      code: "IDEMPOTENCY_KEY_REUSED",
    },
  },
  REQUEST_ABORTED: {
    status: 409,
    body: {
      message: "O envio anterior foi interrompido. Envie de novo.",
      code: "IDEMPOTENCY_REQUEST_ABORTED",
    },
  },
} as const;

const sendErro = (res: Response, erro: (typeof ERRO)[keyof typeof ERRO]) =>
  res.status(erro.status).json(erro.body);

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

/** Escrita sem chave: recusa (`required`) ou segue sem idempotência (`optional`). */
const WITHOUT_KEY: Record<IdempotencyMode, Middleware> = {
  required: (_req, res) => sendErro(res, ERRO.KEY_REQUIRED),
  optional: (_req, _res, next) => next(),
};

/** `Idempotency-Key` é o nome do rascunho da IETF; `x-idempotency-key` é o de sempre. */
const readKey = (req: Request): string | undefined =>
  req.header("idempotency-key") || req.header("x-idempotency-key") || undefined;

/**
 * Mesma chave com outro pedido é engano do cliente (chave reaproveitada depois de mudar o
 * formulário): reproduzir a resposta antiga esconderia que a mudança não foi gravada.
 * O corpo é serializado com as chaves em ordem, em todos os níveis: a ordem dos campos não muda
 * o pedido.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === "[object Object]";

const sortKeys = (_key: string, value: unknown) =>
  isPlainObject(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : value;

function buildFingerprint(req: Request): string {
  const corpo = createHash("sha256")
    .update(JSON.stringify(req.body ?? null, sortKeys))
    .digest("hex");
  return `${req.method.toUpperCase()} ${req.originalUrl ?? req.url}|${corpo}`;
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

/** A chave já existe: reproduz para o mesmo dono e o mesmo pedido, ou recusa. */
async function replay(existing: PendingRequest, owner: string, req: Request, res: Response) {
  // Chave de outro usuário/empresa nunca vaza a resposta.
  if (existing.owner !== owner) return sendErro(res, ERRO.KEY_CONFLICT);
  if (existing.fingerprint !== buildFingerprint(req)) return sendErro(res, ERRO.KEY_REUSED);

  const cached = await existing.promise.catch(() => null);

  // A original caiu antes de responder e liberou a chave: o cliente reenvia.
  if (!cached) return sendErro(res, ERRO.REQUEST_ABORTED);

  incrementMetric(METRICA.IDEMPOTENCY_REPLAY);
  return res.status(cached.status).json(cached.body);
}

export function idempotencyMiddleware(options: IdempotencyOptions = {}) {
  const ttl = options.ttl ?? 60_000;
  const identify = options.identify ?? defaultIdentify;
  const withoutKey = WITHOUT_KEY[options.mode ?? "required"];
  const methods = new Set((options.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()));

  return async function (req: Request, res: Response, next: NextFunction) {
    // Leitura (ou método fora da lista) não grava nada: segue direto.
    if (!methods.has(req.method.toUpperCase())) return next();

    const key = readKey(req);
    if (!key) return withoutKey(req, res, next);

    const owner = identify(req);
    const existing = requests.get(key);

    if (existing) {
      logger.debug(`Replaying response for idempotency key: ${key}`);
      return replay(existing, owner, req, res);
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
      fingerprint: buildFingerprint(req),
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

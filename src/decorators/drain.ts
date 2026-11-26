/**
 * rejectWritesWhenDraining e createDrainRouter: a drenagem pelo HTTP, para o deploy que drena com o
 * servidor no ar.
 *
 * O CI chama `POST /internal/drain`, faz poll em `GET /health/lifecycle` até `ready: true` e só
 * então troca o container. Enquanto isso, as escritas recebem 503 e as leituras seguem. O estado
 * mora em `shutdown.ts` (`beginDrain`, `cancelDrain`, `getDrainStatus`).
 */
import { timingSafeEqual } from "node:crypto";

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";

import { logger } from "../functions/logger";
import { beginDrain, cancelDrain, getDrainStatus, isDraining } from "./shutdown";

export interface RejectWritesWhenDrainingOptions {
  /** Texto da resposta 503. Default: "Servidor em atualização. Tente novamente em instantes." */
  message?: string;
  /** Valor do cabeçalho `Retry-After`, em segundos. Default: 5. */
  retryAfterSeconds?: number;
}

export interface DrainRouterOptions {
  /**
   * Token conferido no cabeçalho `x-drain-token`. Default: `process.env.DRAIN_TOKEN`, lido ao criar
   * o router. Sem nenhum dos dois, os `POST` recusam tudo (401) com `NODE_ENV=production` e ficam
   * abertos fora de produção.
   */
  token?: string;
  /** Default: "/health/lifecycle". */
  statusPath?: string;
  /** Default: "/internal/drain". O cancelamento é `${drainPath}/cancel`. */
  drainPath?: string;
}

const DEFAULT_MESSAGE = "Servidor em atualização. Tente novamente em instantes.";
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TOKEN_HEADER = "x-drain-token";
const INVALID_TOKEN = { message: "Token de drain inválido.", code: "INVALID_DRAIN_TOKEN" };

// ── Middleware ────────────────────────────────────────────────────────────────────────────────

/** Em drenagem, recusa POST, PUT, PATCH e DELETE com 503; o resto segue. */
export function rejectWritesWhenDraining(
  options: RejectWritesWhenDrainingOptions = {},
): RequestHandler {
  const body = { message: options.message ?? DEFAULT_MESSAGE, code: "SERVER_DRAINING" };
  const retryAfter = String(options.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS);

  return (req: Request, res: Response, next: NextFunction) => {
    if (!isDraining() || !WRITE_METHODS.has(req.method)) return next();
    res.setHeader("Retry-After", retryAfter);
    res.status(503).json(body);
  };
}

// ── Rotas ─────────────────────────────────────────────────────────────────────────────────────

/** Compara em tempo constante: o tempo da resposta não revela quanto do token acertou. */
const isSameToken = (recebido: string | undefined, esperado: string): boolean => {
  const a = Buffer.from(recebido ?? "");
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
};

const allowAll: RequestHandler = (_req, _res, next) => next();

const rejectAll: RequestHandler = (_req, res) => {
  res.status(401).json(INVALID_TOKEN);
};

const buildTokenGuard =
  (token: string): RequestHandler =>
  (req, res, next) => {
    if (isSameToken(req.get(TOKEN_HEADER), token)) return next();
    res.status(401).json(INVALID_TOKEN);
  };

interface GuardWithoutToken {
  guard: RequestHandler;
  aviso: string;
}

/**
 * Sem token: em produção ninguém da rede pode drenar o servidor, então os `POST` recusam tudo;
 * fora dela a rota fica aberta para o desenvolvimento.
 */
const GUARD_WITHOUT_TOKEN: Record<"production" | "other", GuardWithoutToken> = {
  production: {
    guard: rejectAll,
    aviso:
      "[@mateusseiboth/ts-decorators] createDrainRouter: sem DRAIN_TOKEN em produção, as rotas de drain estão recusando tudo (401).",
  },
  other: {
    guard: allowAll,
    aviso:
      "[@mateusseiboth/ts-decorators] createDrainRouter: sem token (opção token ou DRAIN_TOKEN), as rotas de drain estão abertas.",
  },
};

const readGuardWithoutToken = (): GuardWithoutToken =>
  GUARD_WITHOUT_TOKEN[process.env.NODE_ENV === "production" ? "production" : "other"];

/** Sem token, avisa no log uma vez, quando o router nasce. */
const buildGuard = (token: string | undefined): RequestHandler => {
  if (token) return buildTokenGuard(token);
  const { guard, aviso } = readGuardWithoutToken();
  logger.warn(aviso);
  return guard;
};

/** `GET` do status, `POST` que começa e `POST` que cancela a drenagem. */
export function createDrainRouter(options: DrainRouterOptions = {}): Router {
  const router = Router();
  const drainPath = options.drainPath ?? "/internal/drain";
  // `||`: DRAIN_TOKEN vazio no ambiente conta como não configurado.
  const guard = buildGuard(options.token || process.env.DRAIN_TOKEN || undefined);

  router.get(options.statusPath ?? "/health/lifecycle", (_req, res) => {
    res.json(getDrainStatus());
  });

  router.post(drainPath, guard, (_req, res) => {
    beginDrain();
    res.status(202).json(getDrainStatus());
  });

  router.post(`${drainPath}/cancel`, guard, (_req, res) => {
    cancelDrain();
    res.json(getDrainStatus());
  });

  return router;
}

import type { NextFunction, Request, Response } from "express";

import type { RouteDefinition } from "./http-methods";

/** Monta a resposta a partir do retorno do handler da rota. */
export type RouteResponder = (
  result: unknown,
  req: Request,
  res: Response,
  def: RouteDefinition,
) => unknown;

/** Handler de rota: o do Express, ou um que devolve o resultado para o `respond`. */
export type RouteHandler = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * O handler seguido do `respond`: roda depois que o handler TERMINA (o que abre e fecha a
 * transação devolve depois do commit), sempre que ninguém respondeu, inclusive com `undefined`
 * (o projeto decide o 204). Handler que chamou `next` passou a vez: o `respond` não roda.
 */
export function withRespond(
  handler: RouteHandler,
  respond: RouteResponder | undefined,
  def: RouteDefinition,
): RouteHandler {
  if (!respond) return handler;
  return async (req, res, next) => {
    let seguiu = false;
    const nextVigiado: NextFunction = (...args: unknown[]) => {
      seguiu = true;
      return (next as (...a: unknown[]) => void)(...args);
    };
    const result = await handler(req, res, nextVigiado);
    if (seguiu || res.headersSent) return;
    await respond(result, req, res, def);
  };
}

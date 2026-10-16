import type { RequestHandler, Router } from "express";

/** Rota de exemplo para o teste do `folderRouter`: dois endpoints e um middleware local. */
export const middlewares: RequestHandler[] = [(_req, _res, next) => next()];

export function registry(router: Router) {
  router.get("/", (_req, res) => res.json([]));
  router.post("/", (_req, res) => res.status(201).json({}));
}

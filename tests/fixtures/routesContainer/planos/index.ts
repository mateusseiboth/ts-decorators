import type { Router } from "express";

/** O que o `folderRouter` entregou ao registry, para o teste conferir. */
export const recebidos: unknown[] = [];

export function registry(_router: Router, montagem: unknown) {
  recebidos.push(montagem);
}

import type { NextFunction, Request, Response } from "express";

import { publishRequestValue } from "../handlers/context";

type ErroDePaginacao = { path: "page" | "offset"; message: string };

const MENSAGEM: Record<ErroDePaginacao["path"], string> = {
  page: "Página inválida. Informe um número inteiro a partir de 1.",
  offset: "Quantidade por página inválida. Informe um número inteiro a partir de 1.",
};

/**
 * O cabeçalho como número, com o mesmo `parseInt` de sempre ("2abc" continua 2). Ausente ou vazio
 * vale o padrão. Zero, negativo ou não numérico é inválido: `skip` negativo derruba o Prisma (500)
 * e `take` negativo devolve linhas de trás para frente com total negativo.
 */
const readInteiro = (valor: string | string[] | undefined, padrao: number): number | null => {
  const texto = Array.isArray(valor) ? valor[0] : valor;
  if (texto == null || texto === "") return padrao;
  const n = parseInt(texto, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

export function getPaginate(req: Request, res: Response, next: NextFunction) {
  if (req.headers.paginate !== "true") return next();

  const page = readInteiro(req.headers.page, 1);
  const offset = readInteiro(req.headers.offset, 10);
  const errors: ErroDePaginacao[] = [];
  if (page === null) errors.push({ path: "page", message: MENSAGEM.page });
  if (offset === null) errors.push({ path: "offset", message: MENSAGEM.offset });
  if (errors.length) {
    res.status(400).json({ message: "Paginação inválida.", errors });
    return;
  }

  publishRequestValue(res, "paginate", { skip: (page! - 1) * offset!, take: offset!, page: page! });
  next();
}

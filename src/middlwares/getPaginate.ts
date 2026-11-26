import type { NextFunction, Request, RequestHandler, Response } from "express";

import { publishRequestValue } from "../handlers/context";

type ErroDePaginacao = { path: "page" | "offset"; message: string };

const MENSAGEM: Record<ErroDePaginacao["path"], string> = {
  page: "Página inválida. Informe um número inteiro a partir de 1.",
  offset: "Quantidade por página inválida. Informe um número inteiro a partir de 1.",
};

export interface PaginateMiddlewareOptions {
  /**
   * Pagina mesmo sem o cabeçalho `paginate: true`: a lista nunca sai inteira. Default: `false`
   * (sem o cabeçalho, a rota devolve a lista inteira, como o `getPaginate`).
   */
  required?: boolean;
  /** Registros por página quando o cabeçalho `offset` não vem. Default: 10. */
  defaultOffset?: number;
  /** Teto do `offset`: acima dele, 400 no campo `offset`. Default: sem teto. */
  maxOffset?: number;
}

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

const isInteiroPositivo = (valor: unknown): boolean =>
  Number.isInteger(valor) && Number(valor) >= 1;

/** Falha na subida, não na requisição, quando as opções não servem. */
const requireOpcoes = ({
  defaultOffset,
  maxOffset,
}: Required<Omit<PaginateMiddlewareOptions, "required">>) => {
  if (
    !isInteiroPositivo(defaultOffset) ||
    !(maxOffset === Infinity || isInteiroPositivo(maxOffset))
  ) {
    throw new TypeError(
      "[@mateusseiboth/ts-decorators] createPaginate: defaultOffset e maxOffset são inteiros a partir de 1.",
    );
  }
  if (defaultOffset > maxOffset) {
    throw new TypeError(
      `[@mateusseiboth/ts-decorators] createPaginate: defaultOffset (${defaultOffset}) acima do maxOffset (${maxOffset}).`,
    );
  }
};

const readErros = (
  page: number | null,
  offset: number | null,
  maxOffset: number,
): ErroDePaginacao[] => {
  const erros: ErroDePaginacao[] = [];
  if (page === null) erros.push({ path: "page", message: MENSAGEM.page });
  if (offset === null) erros.push({ path: "offset", message: MENSAGEM.offset });
  if (offset !== null && offset > maxOffset) {
    erros.push({
      path: "offset",
      message: `Quantidade por página acima do máximo de ${maxOffset}.`,
    });
  }
  return erros;
};

/**
 * Middleware de paginação pelos cabeçalhos `paginate`, `page` e `offset`, com padrão e teto
 * configuráveis. `required` pagina mesmo sem o cabeçalho `paginate`.
 */
export function createPaginate(options: PaginateMiddlewareOptions = {}): RequestHandler {
  const defaultOffset = options.defaultOffset ?? 10;
  const maxOffset = options.maxOffset ?? Infinity;
  requireOpcoes({ defaultOffset, maxOffset });

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.paginate !== "true" && !options.required) return next();

    const page = readInteiro(req.headers.page, 1);
    const offset = readInteiro(req.headers.offset, defaultOffset);
    const errors = readErros(page, offset, maxOffset);
    if (errors.length) {
      res.status(400).json({ message: "Paginação inválida.", errors });
      return;
    }

    publishRequestValue(res, "paginate", {
      skip: (page! - 1) * offset!,
      take: offset!,
      page: page!,
    });
    next();
  };
}

const _paginatePadrao = createPaginate();

/** Paginação opcional (só com `paginate: true`), 10 por página e sem teto. */
export function getPaginate(req: Request, res: Response, next: NextFunction) {
  return _paginatePadrao(req, res, next);
}

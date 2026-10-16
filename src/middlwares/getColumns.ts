import type { NextFunction, Request, Response } from "express";

import { getModel } from "../decorators/getModel";
import { collectFieldMeta } from "../functions/collectFieldsTypes";
import { publishRequestValue } from "../handlers/context";

export interface GetColumnsOptions {
  /** Nome do parâmetro de query lido. Default: `fields`. */
  queryKey?: string;
  /**
   * Campos sempre presentes na projeção, mesmo que o cliente não peça.
   * Default: `["id"]` — o frontend praticamente sempre precisa da chave da linha.
   * Passe `[]` para respeitar exatamente o que veio na query.
   */
  always?: string[];
}

/** Aceita `?fields=id,name` e `?fields=id;name` (mesmo separador do getWhere). */
const FIELD_SEPARATOR = /[,;]/;

/**
 * Normaliza o valor cru da query em uma lista de caminhos.
 * Aceita repetição (`?fields=id&fields=name`) e valores separados por `,`/`;`.
 */
function parseRequestedFields(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.flatMap((value) => parseRequestedFields(value));
  if (typeof raw !== "string") return [];
  return raw
    .split(FIELD_SEPARATOR)
    .map((field) => field.trim())
    .filter(Boolean);
}

/**
 * Insere um caminho com ponto (`bairro.name`) na árvore de select do Prisma,
 * produzindo `{bairro: {select: {name: true}}}`.
 *
 * Pedir a relação inteira (`bairro`) é mais abrangente que pedir um campo dela,
 * então `true` nunca é rebaixado para um select parcial.
 */
function addPathToSelect(select: Record<string, any>, path: string) {
  const [head, ...rest] = path.split(".");
  if (!head) return;

  if (!rest.length) {
    select[head] = true;
    return;
  }

  if (select[head] === true) return; // relação inteira já pedida

  const branch = select[head] ?? { select: {} };
  addPathToSelect(branch.select, rest.join("."));
  select[head] = branch;
}

/**
 * Monta o `select` do Prisma a partir de uma lista de campos, usando o model como
 * whitelist: campo sem `@Field()` (ou fora do model) é silenciosamente ignorado,
 * mesmo padrão do `getWhere`/`getOrderBy`.
 *
 * Retorna `undefined` quando nenhum campo pedido é válido — assim o chamador
 * mantém a projeção original em vez de mandar um `select` vazio para o Prisma.
 */
export function buildSelectFromFields<T extends object>(
  fields: string[],
  classBase: { getModel: () => T; tag: number },
): Record<string, any> | undefined {
  const classRecord = getModel(classBase.tag);
  if (!classRecord) return undefined;

  const { types } = collectFieldMeta(classRecord.prototype);
  const select: Record<string, any> = {};

  fields.filter((field) => field in types).forEach((field) => addPathToSelect(select, field));

  return Object.keys(select).length ? select : undefined;
}

/**
 * Lê `?fields=id,name` e popula `res.locals.columns` (e o contexto, quando há um) com um `select` do Prisma,
 * dando ao frontend autonomia para trazer só o que a tela usa.
 *
 * - Sem `?fields` na query, chama `next()` sem tocar em `res.locals` (rota devolve tudo).
 * - Aceita caminhos aninhados (`?fields=id,bairro.name`) para relações com `@NestedModel`.
 * - `makePrismaOptions` repassa `columns` e o `executePrismaQuery` aplica a projeção,
 *   sempre ESTREITANDO o que o DAO já expõe (nunca ampliando).
 */
export function getColumns<T extends object>(
  req: Request,
  res: Response,
  next: NextFunction,
  classBase: { getModel: () => T; tag: number },
  options: GetColumnsOptions = {},
) {
  const { queryKey = "fields", always = ["id"] } = options;

  const requested = parseRequestedFields(req.query[queryKey]);
  if (!requested.length) return next();

  const columns = buildSelectFromFields([...always, ...requested], classBase);
  if (columns) publishRequestValue(res, "columns", columns);

  next();
}

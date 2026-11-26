/**
 * O filtro conferido contra o contrato da coleção, no que o client do Prisma 7 recusava antes de
 * ir ao banco e o Prisma 8 executaria: nulo em coluna obrigatória (`?nome=isNull:x`). O Prisma 8
 * devolveria a página vazia, sem erro; aqui é o 400 de filtro inválido.
 *
 * Chave que não é coluna do model (relação, campo que o contrato não declara) fica para o ORM.
 */
import { collectionMeta, type OrmCollection } from "./query";

/** Filtro que o contrato recusa. Responde 400. */
export class InvalidFilterError extends Error {
  /** O status HTTP para o `errorHandler`. */
  readonly statusCode = 400;

  constructor(
    readonly campo: string,
    readonly motivo: string,
  ) {
    super(`Filtro inválido em ${campo}: ${motivo}.`);
    this.name = "InvalidFilterError";
  }
}

type Filtro = Record<string, unknown>;
type Colunas = Record<string, { nullable?: boolean }>;

interface ContratoDaColecao {
  domain?: { namespaces?: Record<string, { models?: Record<string, { fields?: Colunas }> }> };
}

const LOGICOS = new Set(["AND", "OR", "NOT"]);

const isFiltro = (valor: unknown): valor is Filtro =>
  typeof valor === "object" && valor !== null && !Array.isArray(valor) && !(valor instanceof Date);

const asList = (valor: unknown): unknown[] => (Array.isArray(valor) ? valor : [valor]);

function readColunas(collection: OrmCollection): Colunas {
  const meta = collectionMeta(collection);
  const contrato = meta.contract as ContratoDaColecao | undefined;
  const namespace = contrato?.domain?.namespaces?.[meta.namespaceId ?? "public"];
  return namespace?.models?.[meta.modelName ?? ""]?.fields ?? {};
}

function checkWhere(colunas: Colunas, where: unknown): void {
  if (!isFiltro(where)) return;
  for (const [chave, valor] of Object.entries(where)) {
    if (LOGICOS.has(chave)) {
      asList(valor).forEach((parte) => checkWhere(colunas, parte));
      continue;
    }
    // O valor solto é o `equals` dele.
    const igualA = isFiltro(valor) ? valor.equals : valor;
    if (igualA === null && colunas[chave]?.nullable === false) {
      throw new InvalidFilterError(chave, "nulo em coluna obrigatória");
    }
  }
}

/** Lança `InvalidFilterError` no filtro que o contrato da coleção recusa. */
export function assertWhereFitsContract(collection: OrmCollection, where: unknown): void {
  checkWhere(readColunas(collection), where);
}

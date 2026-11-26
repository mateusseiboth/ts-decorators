/**
 * Árvore dos dados do relatório para o painel "Campos". O caminho de cada nó usa "[]" para marcar
 * "item da lista": `itens > nome` é `["itens", "[]", "nome"]`. É com esse caminho absoluto que o
 * contexto do cursor decide se o campo sai como `{{nome}}`, `{{@root.nome}}` ou dentro de um each.
 */
export type FieldKind = "lista" | "grupo" | "texto" | "numero" | "simnao" | "vazio" | "data";

export interface SchemaNode {
  key: string;
  path: string[];
  kind: FieldKind;
  sample: string;
  children: SchemaNode[];
}

export interface ListInfo {
  path: string[];
  label: string;
  fields: { name: string; kind: FieldKind }[];
}

const RE_ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$/;
const MAX_SAMPLE = 32;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const KIND_BY_TYPE: Record<string, FieldKind> = {
  number: "numero",
  bigint: "numero",
  boolean: "simnao",
};

function kindOf(value: unknown): FieldKind {
  if (Array.isArray(value)) return "lista";
  if (value == null) return "vazio";
  if (isRecord(value)) return "grupo";
  if (typeof value === "string" && RE_ISO_DATE.test(value)) return "data";
  return KIND_BY_TYPE[typeof value] ?? "texto";
}

function sampleOf(value: unknown): string {
  if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${value.length} itens`;
  if (value == null || isRecord(value)) return "";
  const text = String(value as string);
  return text.length > MAX_SAMPLE ? `${text.slice(0, MAX_SAMPLE)}…` : text;
}

/** O primeiro item que é objeto descreve os campos da lista. */
const firstRecord = (list: unknown[]) => list.find(isRecord);

function childrenOf(value: unknown, path: string[]): SchemaNode[] {
  if (Array.isArray(value)) {
    const first = firstRecord(value);
    return first ? describeObject(first, [...path, "[]"]) : [];
  }
  return isRecord(value) ? describeObject(value, path) : [];
}

function describeObject(value: Record<string, unknown>, parent: string[]): SchemaNode[] {
  return Object.entries(value).map(([key, child]) => {
    const path = [...parent, key];
    return {
      key,
      path,
      kind: kindOf(child),
      sample: sampleOf(child),
      children: childrenOf(child, path),
    };
  });
}

export function describeData(data: unknown): SchemaNode[] {
  return isRecord(data) ? describeObject(data, []) : [];
}

export function collectLists(nodes: readonly SchemaNode[]): ListInfo[] {
  return nodes.flatMap((node) => {
    const nested = collectLists(node.children);
    if (node.kind !== "lista") return nested;
    const own: ListInfo = {
      path: node.path,
      label: node.key,
      fields: node.children.map((child) => ({ name: child.key, kind: child.kind })),
    };
    return [own, ...nested];
  });
}

/** Nó pelo caminho absoluto; "{}" (grupo do groupBy) não existe nos dados e devolve undefined. */
export function findNode(
  nodes: readonly SchemaNode[],
  path: readonly string[],
): SchemaNode | undefined {
  return nodes.reduce<SchemaNode | undefined>((found, node) => {
    if (found) return found;
    if (node.path.join("\u0000") === path.join("\u0000")) return node;
    const isAncestor = path.join("\u0000").startsWith(`${node.path.join("\u0000")}\u0000`);
    return isAncestor ? findNode(node.children, path) : undefined;
  }, undefined);
}

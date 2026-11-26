/**
 * Autocompletar do editor. Só age dentro de um `{{` ainda não fechado e decide o que sugerir pelo
 * que vem logo depois das chaves: `#` abre bloco, `/` fecha o bloco aberto, `>` insere bloco
 * reutilizável, e o resto sugere campos do contexto do cursor e funções.
 */
import { readFrames, readOpenBlocks, type Frame } from "./context";
import { findNode, type SchemaNode } from "./dataSchema";

export interface HelperDocLike {
  name: string;
  description: string;
  snippet: string;
  category: string;
}

export type CompletionKind = "campo" | "lista" | "funcao" | "bloco" | "fechar" | "variavel";

export interface Completion {
  label: string;
  insert: string;
  detail: string;
  kind: CompletionKind;
}

export interface CompletionResult {
  from: number;
  to: number;
  items: Completion[];
}

export interface CompletionContext {
  schema: readonly SchemaNode[];
  helpers: readonly HelperDocLike[];
}

const MAX_ITEMS = 50;
const MAX_DEPTH = 3;

const NATIVE_BLOCKS: readonly Completion[] = [
  {
    label: "each",
    insert: "each ",
    detail: "Repete o trecho para cada item da lista",
    kind: "bloco",
  },
  {
    label: "if",
    insert: "if ",
    detail: "Mostra o trecho quando o campo está preenchido",
    kind: "bloco",
  },
  {
    label: "unless",
    insert: "unless ",
    detail: "Mostra o trecho quando o campo está vazio",
    kind: "bloco",
  },
  { label: "with", insert: "with ", detail: "Entra num grupo de campos", kind: "bloco" },
];

const LOOP_VARIABLES: readonly Completion[] = [
  {
    label: "@index",
    insert: "@index",
    detail: "Posição do item, começando em 0",
    kind: "variavel",
  },
  { label: "@first", insert: "@first", detail: "Verdadeiro no primeiro item", kind: "variavel" },
  { label: "@last", insert: "@last", detail: "Verdadeiro no último item", kind: "variavel" },
];

const PARTIALS: readonly Completion[] = [
  { label: "assinaturas", insert: "assinaturas}}", detail: "Bloco de assinaturas", kind: "bloco" },
];

const isBlockHelper = (helper: HelperDocLike) => helper.snippet.startsWith("{{#");

const GROUP_FIELDS: readonly Completion[] = [
  { label: "key", insert: "key", detail: "Valor que define o grupo", kind: "campo" },
  { label: "count", insert: "count", detail: "Quantidade de itens do grupo", kind: "campo" },
  { label: "items", insert: "items", detail: "Itens do grupo", kind: "lista" },
];

function flattenFields(nodes: readonly SchemaNode[], prefix = "", depth = 1): Completion[] {
  return nodes.flatMap((node) => {
    const label = `${prefix}${node.key}`;
    const own: Completion = {
      label,
      insert: label,
      detail: node.sample || node.kind,
      kind: node.kind === "lista" ? "lista" : "campo",
    };
    const nested =
      node.kind === "grupo" && depth < MAX_DEPTH
        ? flattenFields(node.children, `${label}.`, depth + 1)
        : [];
    return [own, ...nested];
  });
}

function nodesAt(schema: readonly SchemaNode[], abs: readonly string[]): readonly SchemaNode[] {
  if (!abs.length) return schema;
  const isItem = abs.at(-1) === "[]";
  return findNode(schema, isItem ? abs.slice(0, -1) : abs)?.children ?? [];
}

function frameFields(schema: readonly SchemaNode[], frame: Frame): Completion[] {
  if (frame.listAbs) return [...GROUP_FIELDS];
  const fields = flattenFields(nodesAt(schema, frame.abs));
  return frame.helper === "each" ? [...fields, ...LOOP_VARIABLES] : fields;
}

function filterByWord(items: readonly Completion[], word: string): Completion[] {
  const needle = word.toLowerCase();
  const matches = items.filter((item) => item.label.toLowerCase().includes(needle));
  const rank = (item: Completion) => (item.label.toLowerCase().startsWith(needle) ? 0 : 1);
  return matches.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ITEMS);
}

interface Cursor {
  /** Texto antes do `{{` aberto. */
  outside: string;
  /** Texto entre o `{{` e o cursor. */
  inside: string;
  after: string;
}

function readCursor(text: string, caret: number): Cursor | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf("{{");
  if (open === -1 || before.lastIndexOf("}}") > open) return null;
  return {
    outside: before.slice(0, open),
    inside: before.slice(open + 2),
    after: text.slice(caret),
  };
}

function closeItems(cursor: Cursor): Completion[] {
  const block = readOpenBlocks(cursor.outside).at(-1);
  if (!block) return [];
  const opener = `{{#${block.helper}${block.args ? ` ${block.args}` : ""}}}`;
  return [
    {
      label: block.helper,
      insert: `${block.helper}}}`,
      detail: `Fecha o ${opener}`,
      kind: "fechar",
    },
  ];
}

function blockItems(helpers: readonly HelperDocLike[]): Completion[] {
  const custom = helpers.filter(isBlockHelper).map<Completion>((helper) => ({
    label: helper.name,
    insert: `${helper.name} `,
    detail: helper.description,
    kind: "bloco",
  }));
  return [...NATIVE_BLOCKS, ...custom];
}

function helperItems(helpers: readonly HelperDocLike[]): Completion[] {
  return helpers
    .filter((helper) => !isBlockHelper(helper))
    .map((helper) => ({
      label: helper.name,
      insert: `${helper.name} `,
      detail: helper.description,
      kind: "funcao",
    }));
}

function rootFieldItems(schema: readonly SchemaNode[]): Completion[] {
  return flattenFields(schema, "@root.");
}

function expressionItems(cursor: Cursor, word: string, sigil: string, ctx: CompletionContext) {
  const isFirstToken = cursor.inside.replace(/^~?[#^]?\s*/, "") === word;
  const afterParen = cursor.inside.at(-word.length - 1) === "(";
  const frames = readFrames(cursor.outside);
  const fields = word.startsWith("@root.")
    ? rootFieldItems(ctx.schema)
    : frameFields(ctx.schema, frames.at(-1)!);
  const closesTag = isFirstToken && !sigil && !cursor.after.startsWith("}}");
  const closedFields = closesTag
    ? fields.map((item) => ({ ...item, insert: `${item.insert}}}` }))
    : fields;
  const helpers = (isFirstToken && !sigil) || afterParen ? helperItems(ctx.helpers) : [];
  return [...closedFields, ...helpers];
}

type ModeItems = (cursor: Cursor, word: string, ctx: CompletionContext) => Completion[];

const SIGIL_MODES: Record<string, ModeItems> = {
  "/": (cursor) => closeItems(cursor),
  ">": () => [...PARTIALS],
};

export function suggest(
  text: string,
  caret: number,
  ctx: CompletionContext,
): CompletionResult | null {
  const cursor = readCursor(text, caret);
  if (!cursor) return null;
  const sigil = /^~?\s*([#^/>])?/.exec(cursor.inside)?.[1] ?? "";
  const word = /[\w.@-]*$/.exec(cursor.inside)?.[0] ?? "";
  const isOpeningBlock = sigil === "#" && /^~?\s*#\s*[\w-]*$/.test(cursor.inside);
  const mode = SIGIL_MODES[sigil];
  const items = mode
    ? mode(cursor, word, ctx)
    : isOpeningBlock
      ? blockItems(ctx.helpers)
      : expressionItems(cursor, word, sigil, ctx);
  return { from: caret - word.length, to: caret, items: filterByWord(items, word) };
}

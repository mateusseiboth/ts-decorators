/**
 * Contexto do cursor: quais blocos estão abertos antes dele e, para os que trocam o contexto
 * (`each`, `with`, `groupBy`), qual caminho absoluto dos dados cada um representa.
 *
 * Caminhos usam os marcadores da árvore de dados: "[]" é item de lista e "{}" é o grupo do
 * `groupBy` (que expõe key, count e items).
 */
export interface OpenBlock {
  helper: string;
  args: string;
}

export interface Frame {
  helper: string;
  abs: string[];
  /** Só no grupo do groupBy: a lista agrupada, que o `items` do grupo devolve. */
  listAbs?: string[];
}

const RE_BLOCK_TAG = /\{\{~?\s*([#^/])\s*([\w-]+)([^}]*)\}\}/g;

export function readOpenBlocks(text: string): OpenBlock[] {
  const stack: OpenBlock[] = [];
  for (const [, sigil, helper = "", args = ""] of text.matchAll(RE_BLOCK_TAG)) {
    if (sigil === "/") stack.pop();
    if (sigil !== "/") stack.push({ helper, args: args.trim() });
  }
  return stack;
}

const firstArg = (args: string) => args.split(/\s+/)[0] ?? "";

const ROOT: Frame = { helper: "", abs: [] };

function resolveExpr(expr: string, frames: readonly Frame[]): string[] {
  if (expr.startsWith("@root.")) return expr.slice(6).split(".").filter(Boolean);
  const depth = expr.match(/^(\.\.\/)*/)?.[0].length ?? 0;
  const rest = expr.slice(depth).replace(/^(this\.?|\.\/)/, "");
  const base = frames[frames.length - 1 - depth / 3] ?? ROOT;
  const segments = rest.split(".").filter(Boolean);
  if (base.listAbs && segments[0] === "items") return [...base.listAbs, ...segments.slice(1)];
  return [...base.abs, ...segments];
}

type FrameBuilder = (target: string[], helper: string) => Frame;

const FRAME_BUILDERS: Record<string, FrameBuilder> = {
  each: (target, helper) => ({ helper, abs: [...target, "[]"] }),
  with: (target, helper) => ({ helper, abs: target }),
  groupBy: (target, helper) => ({ helper, abs: [...target, "{}"], listAbs: target }),
};

/** Raiz + um frame por bloco aberto que troca o contexto, do mais externo ao mais interno. */
export function readFrames(textBefore: string): Frame[] {
  return readOpenBlocks(textBefore).reduce<Frame[]>(
    (frames, block) => {
      const build = FRAME_BUILDERS[block.helper];
      if (!build) return frames;
      return [...frames, build(resolveExpr(firstArg(block.args), frames), block.helper)];
    },
    [ROOT],
  );
}

const startsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.every((segment, index) => path[index] === segment);

interface Relative {
  prefix: string;
  rel: string[];
}

/** O frame mais interno que contém o caminho, e o prefixo para alcançá-lo dali. */
function relativeTo(abs: readonly string[], frames: readonly Frame[]): Relative {
  for (let depth = 0; depth < frames.length; depth++) {
    const frame = frames[frames.length - 1 - depth]!;
    if (!startsWith(abs, frame.abs)) continue;
    const prefix = depth === 0 ? "" : frame.abs.length ? "../".repeat(depth) : "@root.";
    return { prefix, rel: abs.slice(frame.abs.length) };
  }
  return { prefix: "", rel: [...abs] };
}

function renderInsertion({ prefix, rel }: Relative): string {
  const listEnd = rel.indexOf("[]");
  if (listEnd === -1) return `{{${prefix}${rel.join(".") || "this"}}}`;
  const list = `${prefix}${rel.slice(0, listEnd).join(".")}`;
  const inner = renderInsertion({ prefix: "", rel: rel.slice(listEnd + 1) });
  return `{{#each ${list}}}${inner}{{/each}}`;
}

/** O cursor está entre um `{{` e o seu `}}`. */
const isInsideMustache = (textBefore: string) =>
  textBefore.lastIndexOf("{{") > textBefore.lastIndexOf("}}");

/**
 * O texto que insere o campo no ponto do cursor, entrando nas listas que faltarem. Com o cursor
 * já dentro de `{{ }}` (parâmetro de uma função, por exemplo) entra só a expressão.
 */
export function buildFieldInsertion(abs: readonly string[], textBefore: string): string {
  const { prefix, rel } = relativeTo(abs, readFrames(textBefore));
  const isPlainField = !rel.includes("[]");
  if (isPlainField && isInsideMustache(textBefore)) return `${prefix}${rel.join(".") || "this"}`;
  return renderInsertion({ prefix, rel });
}

/** A expressão da lista vista do cursor, ou null quando ela está dentro de outra lista. */
export function listExprAt(abs: readonly string[], textBefore: string): string | null {
  const { prefix, rel } = relativeTo(abs, readFrames(textBefore));
  return rel.includes("[]") ? null : `${prefix}${rel.join(".")}`;
}

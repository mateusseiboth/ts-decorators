/**
 * Painel "Campos dos dados". Cada campo insere o texto certo para o ponto do cursor: dentro do
 * each da lista sai `{{nome}}`, fora dele o Studio embrulha no each, e campo da raiz dentro de um
 * laço sai com `@root.`. O mesmo vale ao arrastar e soltar no editor.
 */
import { buildFieldInsertion, listExprAt } from "../logic/context";
import { findNode, type SchemaNode } from "../logic/dataSchema";
import { byId, h, inputById, toast } from "./dom";
import type { Editor } from "./editor";
import { iconSvg } from "./icons";
import { on, state } from "./state";

const PATH_MIME = "application/x-studio-path";

const KIND_LABEL: Record<SchemaNode["kind"], string> = {
  lista: "lista",
  grupo: "grupo",
  texto: "texto",
  numero: "número",
  simnao: "sim/não",
  vazio: "vazio",
  data: "data",
};

/** Texto inserido para o nó, visto do ponto `textBefore`. */
export function insertionFor(node: SchemaNode, textBefore: string): string {
  if (node.kind !== "lista") return buildFieldInsertion(node.path, textBefore);
  const expr = listExprAt(node.path, textBefore);
  return expr
    ? `{{#each ${expr}}}\n  \n{{/each}}`
    : buildFieldInsertion([...node.path, "[]"], textBefore);
}

export interface DataPanelOptions {
  /** Clique no + de uma lista abre o assistente de tabela com ela escolhida. */
  onListPicked(node: SchemaNode): void;
}

export class DataPanel {
  private readonly tree = byId("dataTree");
  private readonly search = inputById("fieldSearch");
  private readonly collapsed = new Set<string>();

  constructor(
    private readonly editor: Editor,
    private readonly options: DataPanelOptions,
  ) {
    this.search.addEventListener("input", () => this.render());
    on("data", () => this.render());
    this.bindDrop();
  }

  render(): void {
    const term = this.search.value.trim().toLowerCase();
    const nodes = state.schema.map((node) => this.renderNode(node, term)).filter(Boolean);
    this.tree.replaceChildren(
      ...(nodes.length ? (nodes as HTMLElement[]) : [this.emptyHint(term)]),
    );
  }

  private emptyHint(term: string): HTMLElement {
    const text = term
      ? "Nenhum campo com esse nome."
      : "Nenhum dado carregado. Cole um JSON no botão de editar ou conecte ao sistema.";
    return h("div", { class: "hint", text });
  }

  private matches(node: SchemaNode, term: string): boolean {
    if (!term) return true;
    return (
      node.key.toLowerCase().includes(term) || node.children.some((c) => this.matches(c, term))
    );
  }

  private renderNode(node: SchemaNode, term: string): HTMLElement | null {
    if (!this.matches(node, term)) return null;
    const id = node.path.join(".");
    const isCollapsed = !term && this.collapsed.has(id);
    const children = node.children.map((child) => this.renderNode(child, term)).filter(Boolean);
    return h(
      "div",
      { class: isCollapsed ? "node collapsed" : "node", attrs: { role: "treeitem" } },
      this.renderRow(node, term, Boolean(children.length)),
      children.length ? h("div", { class: "node-children" }, ...(children as HTMLElement[])) : null,
    );
  }

  private renderRow(node: SchemaNode, term: string, hasChildren: boolean): HTMLElement {
    const id = node.path.join(".");
    const caret = hasChildren
      ? h("button", {
          class: "caret",
          text: this.collapsed.has(id) ? "▸" : "▾",
          title: "Mostrar ou esconder os campos",
          on: {
            click: (event) => {
              event.stopPropagation();
              this.toggle(id);
            },
          },
        })
      : h("span", { class: "caret" });
    const add = h("button", {
      class: "node-add",
      title: node.kind === "lista" ? "Montar uma tabela com esta lista" : "Inserir no cursor",
      on: {
        click: (event) => {
          event.stopPropagation();
          this.pick(node);
        },
      },
    });
    add.innerHTML = iconSvg("plus");
    const row = h(
      "div",
      {
        class: "node-row",
        title: `Arraste para o modelo ou clique no +. Caminho: ${node.path.filter((p) => p !== "[]").join(" > ")}`,
        attrs: { draggable: "true", tabindex: "0" },
        on: {
          dragstart: (event) => this.onDragStart(event as DragEvent, node),
          keydown: (event) => {
            if ((event as KeyboardEvent).key === "Enter") this.pick(node);
          },
        },
      },
      caret,
      this.highlightKey(node.key, term),
      h("span", { class: `kind ${node.kind}`, text: KIND_LABEL[node.kind] }),
      h("span", { class: "sample", text: node.sample }),
      add,
    );
    return row;
  }

  private highlightKey(key: string, term: string): HTMLElement {
    const index = term ? key.toLowerCase().indexOf(term) : -1;
    if (index === -1) return h("span", { class: "key", text: key });
    return h(
      "span",
      { class: "key" },
      key.slice(0, index),
      h("mark", { text: key.slice(index, index + term.length) }),
      key.slice(index + term.length),
    );
  }

  private toggle(id: string): void {
    if (!this.collapsed.delete(id)) this.collapsed.add(id);
    this.render();
  }

  private pick(node: SchemaNode): void {
    if (node.kind === "lista") {
      this.options.onListPicked(node);
      return;
    }
    const text = insertionFor(node, this.editor.textBefore());
    this.editor.insert(text);
    toast(`Inserido: ${text.split("\n")[0]}`);
  }

  private onDragStart(event: DragEvent, node: SchemaNode): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(PATH_MIME, JSON.stringify(node.path));
    event.dataTransfer.setData("text/plain", insertionFor(node, ""));
    event.dataTransfer.effectAllowed = "copy";
  }

  /** No modo sem quebra de linha, o Studio sabe a posição exata e ajusta o campo a ela. */
  private bindDrop(): void {
    const textarea = this.editor.textarea;
    const wrap = byId("editorWrap");
    textarea.addEventListener("dragover", () => wrap.classList.add("dropping"));
    textarea.addEventListener("dragleave", () => wrap.classList.remove("dropping"));
    textarea.addEventListener("drop", (event) => {
      wrap.classList.remove("dropping");
      const raw = event.dataTransfer?.getData(PATH_MIME);
      const offset = this.editor.offsetAtPoint(event.clientX, event.clientY);
      if (!raw || offset === null) return;
      event.preventDefault();
      const node = findNode(state.schema, JSON.parse(raw) as string[]);
      if (!node) return;
      this.editor.select(offset);
      this.editor.insert(insertionFor(node, this.editor.textBefore(offset)));
    });
  }
}

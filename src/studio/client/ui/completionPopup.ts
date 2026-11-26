/**
 * Popup do autocompletar. Abre sozinho ao digitar dentro de `{{` e com Ctrl+Espaço; setas
 * navegam, Enter ou Tab aceitam, Esc fecha.
 */
import { suggest, type Completion, type CompletionResult } from "../logic/completion";
import { byId, h } from "./dom";
import type { Editor } from "./editor";
import { state } from "./state";

const KIND_LETTER: Record<Completion["kind"], string> = {
  campo: "C",
  lista: "L",
  funcao: "ƒ",
  bloco: "#",
  fechar: "/",
  variavel: "@",
};

export class CompletionPopup {
  private readonly element = byId("completion");
  private result: CompletionResult | null = null;
  private active = 0;

  constructor(private readonly editor: Editor) {
    editor.keyInterceptors.push((_editor, event) => this.onKey(event));
    editor.textarea.addEventListener("input", (event) => {
      if ((event as InputEvent).inputType?.startsWith("insert")) this.update(false);
      if ((event as InputEvent).inputType?.startsWith("delete")) this.update(true);
    });
    editor.textarea.addEventListener("blur", () => this.close());
    editor.textarea.addEventListener("click", () => this.close());
    this.element.addEventListener("mousedown", (event) => event.preventDefault());
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** `onlyIfOpen`: apagar texto só atualiza a lista que já está aberta. */
  update(onlyIfOpen: boolean): void {
    if (onlyIfOpen && !this.isOpen) return;
    const result = suggest(this.editor.value, this.editor.caret(), {
      schema: state.schema,
      helpers: state.helpers,
    });
    if (!result?.items.length) {
      this.close();
      return;
    }
    this.result = result;
    this.active = 0;
    this.render();
  }

  close(): void {
    this.element.hidden = true;
    this.result = null;
  }

  private render(): void {
    const items = this.result?.items ?? [];
    this.element.replaceChildren(
      ...items.map((item, index) =>
        h(
          "div",
          {
            class: index === this.active ? "cmp active" : "cmp",
            attrs: { role: "option", "aria-selected": String(index === this.active) },
            on: { click: () => this.accept(index) },
          },
          h("span", { class: `kind-tag ${item.kind}`, text: KIND_LETTER[item.kind] }),
          h("span", { class: "label", text: item.label }),
          h("span", { class: "detail", text: item.detail }),
        ),
      ),
    );
    const { left, top } = this.editor.caretCoordinates();
    const maxLeft = this.element.parentElement!.clientWidth - 350;
    this.element.style.left = `${Math.max(4, Math.min(left, maxLeft))}px`;
    this.element.style.top = `${top + 2}px`;
    this.element.hidden = false;
    this.element.children[this.active]?.scrollIntoView({ block: "nearest" });
  }

  private accept(index: number): void {
    const item = this.result?.items[index];
    if (!item || !this.result) return;
    const { from, to } = this.result;
    this.close();
    this.editor.replaceRange(from, to, item.insert);
    // Depois de "each " ou "currency " o próximo passo é escolher o campo.
    if (item.insert.endsWith(" ")) this.update(false);
  }

  private move(delta: number): void {
    const size = this.result?.items.length ?? 0;
    this.active = (this.active + delta + size) % size;
    this.render();
  }

  private onKey(event: KeyboardEvent): boolean {
    const isManualOpen = (event.ctrlKey || event.metaKey) && event.key === " ";
    if (isManualOpen) {
      this.update(false);
      return true;
    }
    if (!this.isOpen) return false;
    const handlers: Record<string, () => void> = {
      ArrowDown: () => this.move(1),
      ArrowUp: () => this.move(-1),
      Enter: () => this.accept(this.active),
      Tab: () => this.accept(this.active),
      Escape: () => this.close(),
    };
    const handler = handlers[event.key];
    handler?.();
    return Boolean(handler);
  }
}

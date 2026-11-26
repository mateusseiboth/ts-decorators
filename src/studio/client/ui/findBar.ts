/** Procurar e substituir no modelo (Ctrl+F), sem diferenciar maiúsculas. */
import { byId, inputById } from "./dom";
import type { Editor } from "./editor";

export class FindBar {
  private readonly bar = byId("findBar");
  private readonly input = inputById("findInput");
  private readonly replacement = inputById("replaceInput");
  private readonly count = byId("findCount");

  constructor(private readonly editor: Editor) {
    this.input.addEventListener("input", () => this.find(1, true));
    this.input.addEventListener("keydown", (event) => this.onKey(event));
    this.replacement.addEventListener("keydown", (event) => this.onKey(event));
    byId("findNext").addEventListener("click", () => this.find(1));
    byId("findPrev").addEventListener("click", () => this.find(-1));
    byId("replaceOne").addEventListener("click", () => this.replaceOne());
    byId("replaceAll").addEventListener("click", () => this.replaceAll());
    byId("findClose").addEventListener("click", () => this.close());
  }

  open(): void {
    const { selectionStart, selectionEnd } = this.editor.textarea;
    const selected = this.editor.value.slice(selectionStart, selectionEnd);
    if (selected && !selected.includes("\n")) this.input.value = selected;
    this.bar.hidden = false;
    this.input.focus();
    this.input.select();
    this.updateCount();
  }

  close(): void {
    this.bar.hidden = true;
    this.editor.textarea.focus();
  }

  private matches(): number[] {
    const needle = this.input.value.toLowerCase();
    if (!needle) return [];
    const haystack = this.editor.value.toLowerCase();
    const found: number[] = [];
    for (
      let index = haystack.indexOf(needle);
      index !== -1;
      index = haystack.indexOf(needle, index + needle.length)
    ) {
      found.push(index);
    }
    return found;
  }

  private updateCount(current?: number): void {
    const total = this.matches().length;
    this.count.textContent = !this.input.value
      ? ""
      : total
        ? `${current ?? "-"} de ${total}`
        : "Nada encontrado";
  }

  /** `fromSelectionStart`: ao digitar, a busca recomeça do início da seleção atual. */
  private find(direction: 1 | -1, fromSelectionStart = false): void {
    const found = this.matches();
    if (!found.length) {
      this.updateCount();
      return;
    }
    const start = this.editor.textarea.selectionStart;
    const after = fromSelectionStart ? start - 1 : start;
    const next =
      direction === 1
        ? (found.find((index) => index > after) ?? found[0]!)
        : (found.findLast((index) => index < start) ?? found.at(-1)!);
    this.editor.goTo(this.editor.positionOf(next));
    this.editor.textarea.setSelectionRange(next, next + this.input.value.length);
    this.input.focus();
    this.updateCount(found.indexOf(next) + 1);
  }

  private replaceOne(): void {
    const { selectionStart, selectionEnd } = this.editor.textarea;
    const selected = this.editor.value.slice(selectionStart, selectionEnd);
    if (selected.toLowerCase() === this.input.value.toLowerCase() && selected) {
      this.editor.replaceRange(selectionStart, selectionEnd, this.replacement.value);
    }
    this.find(1);
  }

  private replaceAll(): void {
    const found = this.matches();
    if (!found.length) return;
    const size = this.input.value.length;
    let result = "";
    let last = 0;
    for (const index of found) {
      result += this.editor.value.slice(last, index) + this.replacement.value;
      last = index + size;
    }
    this.editor.replaceRange(0, this.editor.value.length, result + this.editor.value.slice(last));
    this.count.textContent = `${found.length} substituído(s)`;
  }

  private onKey(event: KeyboardEvent): void {
    const handlers: Record<string, () => void> = {
      Escape: () => this.close(),
      Enter: () =>
        event.target === this.replacement ? this.replaceOne() : this.find(event.shiftKey ? -1 : 1),
    };
    const handler = handlers[event.key];
    if (!handler) return;
    event.preventDefault();
    handler();
  }
}

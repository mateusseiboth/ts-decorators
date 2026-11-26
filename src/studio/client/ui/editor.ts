/**
 * Editor do modelo: textarea transparente sobre o realce colorido, com numeração de linhas, marca
 * nas linhas com problema e na linha atual.
 *
 * Toda inserção passa por `document.execCommand("insertText")`, que entra na pilha de desfazer do
 * navegador: Ctrl+Z desfaz também o que os assistentes e o arrastar inseriram.
 */
import { highlightTemplate } from "../logic/highlight";
import type { Problem } from "./api";
import { byId, h } from "./dom";

const PADDING_TOP = 12;
const PADDING_LEFT = 16;
const INDENT = "  ";

export interface Position {
  line: number;
  column: number;
}

type KeyHandler = (editor: Editor, event: KeyboardEvent) => boolean;

export class Editor {
  readonly textarea = byId<HTMLTextAreaElement>("editor");
  private readonly code = byId("editorCode");
  private readonly highlight = byId("editorHl");
  private readonly gutter = byId("gutter");
  private readonly marks = byId("lineMarks");
  private readonly body = byId("editorBody");
  private readonly wrapper = byId("editorWrap");
  private readonly mirror = h("div");
  private lineCount = 0;
  private problemLines = new Map<number, "err" | "warn">();
  private readonly changeListeners: (() => void)[] = [];
  private readonly cursorListeners: (() => void)[] = [];
  /** Teclas tratadas antes do editor (autocompletar), em ordem. */
  readonly keyInterceptors: KeyHandler[] = [];

  constructor() {
    this.mirror.setAttribute("aria-hidden", "true");
    this.wrapper.append(this.mirror);
    this.textarea.addEventListener("input", () => this.changed());
    this.textarea.addEventListener("scroll", () => this.syncScroll());
    this.textarea.addEventListener("keydown", (event) => this.onKeyDown(event));
    for (const type of ["keyup", "click", "select", "focus"]) {
      this.textarea.addEventListener(type, () => this.cursorMoved());
    }
  }

  get value(): string {
    return this.textarea.value;
  }

  get isWrapping(): boolean {
    return this.body.classList.contains("wrap");
  }

  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  onCursor(listener: () => void): void {
    this.cursorListeners.push(listener);
  }

  caret(): number {
    return this.textarea.selectionStart;
  }

  textBefore(offset = this.caret()): string {
    return this.value.slice(0, offset);
  }

  /** Troca o intervalo pelo texto, com desfazer; o cursor vai para o fim do que entrou. */
  replaceRange(from: number, to: number, text: string): void {
    this.textarea.focus();
    this.textarea.setSelectionRange(from, to);
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      this.textarea.setRangeText(text, from, to, "end");
      this.changed();
    }
  }

  insert(text: string): void {
    this.replaceRange(this.textarea.selectionStart, this.textarea.selectionEnd, text);
  }

  /** `pattern` usa "|" para marcar onde fica a seleção: "<b>|</b>". */
  wrap(pattern: string): void {
    const { selectionStart: start, selectionEnd: end } = this.textarea;
    const [before = "", after = ""] = pattern.split("|");
    const selected = this.value.slice(start, end);
    this.replaceRange(start, end, before + selected + after);
    if (!selected) this.select(start + before.length, start + before.length);
  }

  setValue(text: string): void {
    this.replaceRange(0, this.value.length, text);
    this.select(0, 0);
    this.textarea.scrollTop = 0;
  }

  select(from: number, to = from): void {
    this.textarea.focus();
    this.textarea.setSelectionRange(from, to);
    this.cursorMoved();
  }

  positionOf(offset: number): Position {
    const before = this.textBefore(offset);
    const line = before.split("\n").length;
    return { line, column: offset - before.lastIndexOf("\n") };
  }

  offsetOf({ line, column }: Position): number {
    const lines = this.value.split("\n");
    const lineStart = lines.slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0);
    const lineLength = lines[line - 1]?.length ?? 0;
    return lineStart + Math.min(Math.max(column - 1, 0), lineLength);
  }

  /** Leva o cursor à posição e rola até ela, no meio da tela. */
  goTo(position: Position): void {
    const offset = this.offsetOf(position);
    this.select(offset);
    const top = PADDING_TOP + (position.line - 1) * this.lineHeight();
    this.textarea.scrollTop = Math.max(0, top - this.textarea.clientHeight / 2);
  }

  setProblems(problems: readonly Problem[]): void {
    this.problemLines = new Map();
    for (const problem of problems) {
      const current = this.problemLines.get(problem.line);
      if (current !== "err")
        this.problemLines.set(problem.line, problem.severity === "error" ? "err" : "warn");
    }
    this.renderGutter(true);
    this.renderMarks();
  }

  toggleWrap(): void {
    this.body.classList.toggle("wrap");
    this.refresh();
  }

  refresh(): void {
    this.code.innerHTML = `${highlightTemplate(this.value)}\n`;
    this.renderGutter(false);
    this.renderMarks();
    this.syncScroll();
  }

  /** Coordenadas do cursor dentro de #editorBody (para o autocompletar). */
  caretCoordinates(): { left: number; top: number } {
    const style = getComputedStyle(this.textarea);
    Object.assign(this.mirror.style, {
      position: "absolute",
      visibility: "hidden",
      top: "0",
      left: "0",
      width: `${this.textarea.clientWidth}px`,
      font: style.font,
      padding: style.padding,
      whiteSpace: style.whiteSpace,
      overflowWrap: style.overflowWrap,
      tabSize: style.tabSize,
    });
    const marker = h("span", { text: "​" });
    this.mirror.replaceChildren(this.textBefore(), marker);
    return {
      left: this.wrapper.offsetLeft + marker.offsetLeft - this.textarea.scrollLeft,
      top: marker.offsetTop + this.lineHeight() - this.textarea.scrollTop,
    };
  }

  /** Posição no texto sob o ponteiro; null no modo de quebra de linha (o navegador resolve). */
  offsetAtPoint(clientX: number, clientY: number): number | null {
    if (this.isWrapping) return null;
    const rect = this.textarea.getBoundingClientRect();
    const y = clientY - rect.top + this.textarea.scrollTop - PADDING_TOP;
    const x = clientX - rect.left + this.textarea.scrollLeft - PADDING_LEFT;
    const line = Math.min(Math.max(Math.floor(y / this.lineHeight()) + 1, 1), this.lineCountNow());
    return this.offsetOf({ line, column: Math.round(x / this.charWidth()) + 1 });
  }

  private lineHeight(): number {
    return Number.parseFloat(getComputedStyle(this.textarea).lineHeight) || 20;
  }

  private charWidthCache = 0;

  private charWidth(): number {
    if (this.charWidthCache) return this.charWidthCache;
    const probe = h("span", { text: "0".repeat(100) });
    probe.style.font = getComputedStyle(this.textarea).font;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    this.charWidthCache = probe.getBoundingClientRect().width / 100 || 7.8;
    probe.remove();
    return this.charWidthCache;
  }

  private lineCountNow(): number {
    return this.value.split("\n").length;
  }

  private changed(): void {
    this.refresh();
    for (const listener of this.changeListeners) listener();
    this.cursorMoved();
  }

  private cursorMoved(): void {
    this.renderGutter(false);
    this.renderMarks();
    for (const listener of this.cursorListeners) listener();
  }

  private syncScroll(): void {
    const { scrollTop, scrollLeft } = this.textarea;
    this.highlight.scrollTop = scrollTop;
    this.highlight.scrollLeft = scrollLeft;
    this.gutter.scrollTop = scrollTop;
    this.marks.style.transform = `translateY(${-scrollTop}px)`;
  }

  private renderGutter(force: boolean): void {
    const count = this.lineCountNow();
    if (force || count !== this.lineCount) {
      this.lineCount = count;
      const rows = Array.from({ length: count }, (_, index) => {
        const mark = this.problemLines.get(index + 1);
        return h("div", { text: String(index + 1), ...(mark && { class: mark }) });
      });
      // Espaço no fim para a última linha rolar até o topo do textarea, como o próprio textarea.
      this.gutter.replaceChildren(...rows, h("div"));
    }
    const current = this.positionOf(this.caret()).line;
    this.gutter.querySelector(".current")?.classList.remove("current");
    this.gutter.children[current - 1]?.classList.add("current");
    this.gutter.scrollTop = this.textarea.scrollTop;
  }

  private renderMarks(): void {
    if (this.isWrapping) {
      this.marks.replaceChildren();
      return;
    }
    const height = this.lineHeight();
    const mark = (line: number, cls: string) => {
      const div = h("div", { class: cls });
      div.style.top = `${PADDING_TOP + (line - 1) * height}px`;
      return div;
    };
    const current = this.positionOf(this.caret()).line;
    const problems = [...this.problemLines].map(([line, cls]) => mark(line, cls));
    this.marks.replaceChildren(mark(current, "current"), ...problems);
  }

  private onKeyDown(event: KeyboardEvent): void {
    for (const intercept of this.keyInterceptors) {
      if (intercept(this, event)) {
        event.preventDefault();
        return;
      }
    }
    const handler = EDITOR_KEYS[keyName(event)];
    if (handler?.(this, event)) event.preventDefault();
  }

  // ── Comandos de edição ────────────────────────────────────────────────────

  selectedLines(): { start: number; end: number; text: string } {
    const { selectionStart, selectionEnd } = this.textarea;
    const start = this.value.lastIndexOf("\n", selectionStart - 1) + 1;
    const endBreak = this.value.indexOf("\n", selectionEnd);
    const end = endBreak === -1 ? this.value.length : endBreak;
    return { start, end, text: this.value.slice(start, end) };
  }

  indent(outdent: boolean): void {
    const { selectionStart, selectionEnd } = this.textarea;
    const isMultiLine = this.value.slice(selectionStart, selectionEnd).includes("\n");
    if (!isMultiLine && !outdent) {
      this.insert(INDENT);
      return;
    }
    const { start, end, text } = this.selectedLines();
    const lines = text.split("\n");
    const changed = lines.map((line) =>
      outdent ? line.replace(/^ {1,2}|^\t/, "") : INDENT + line,
    );
    const result = changed.join("\n");
    this.replaceRange(start, end, result);
    this.select(start, start + result.length);
  }

  newLineKeepingIndent(): void {
    const { text } = this.selectedLines();
    const indent = /^\s*/.exec(text)?.[0] ?? "";
    const before = this.textBefore();
    const opensBlock =
      /\{\{#[^}]*\}\}\s*$|<(div|table|tr|tbody|thead|ul|ol|section)[^>]*>\s*$/.test(before);
    this.insert(`\n${indent}${opensBlock ? INDENT : ""}`);
  }

  toggleComment(): void {
    const { selectionStart, selectionEnd } = this.textarea;
    const hasSelection = selectionStart !== selectionEnd;
    const range = hasSelection
      ? {
          start: selectionStart,
          end: selectionEnd,
          text: this.value.slice(selectionStart, selectionEnd),
        }
      : this.selectedLines();
    const commented = /^\s*\{\{!--([^]*)--\}\}\s*$/.exec(range.text);
    const replacement = commented ? (commented[1] ?? "").trim() : `{{!-- ${range.text.trim()} --}}`;
    const indent = hasSelection || commented ? "" : (/^\s*/.exec(range.text)?.[0] ?? "");
    this.replaceRange(range.start, range.end, indent + replacement);
  }

  /** Digitar "{" logo depois de "{" fecha as chaves e deixa o cursor no meio. */
  closeBraces(): boolean {
    const caret = this.caret();
    const hasSelection = this.textarea.selectionEnd !== caret;
    if (hasSelection || this.value[caret - 1] !== "{" || this.value.startsWith("}}", caret)) {
      return false;
    }
    this.insert("{}}");
    this.select(caret + 1);
    return true;
  }
}

function keyName(event: KeyboardEvent): string {
  const mod = event.ctrlKey || event.metaKey ? "ctrl+" : "";
  const shift = event.shiftKey ? "shift+" : "";
  return `${mod}${shift}${event.key.toLowerCase()}`;
}

const EDITOR_KEYS: Record<string, KeyHandler> = {
  tab: (editor) => (editor.indent(false), true),
  "shift+tab": (editor) => (editor.indent(true), true),
  enter: (editor) => (editor.newLineKeepingIndent(), true),
  "ctrl+/": (editor) => (editor.toggleComment(), true),
  "{": (editor) => editor.closeBraces(),
  "shift+{": (editor) => editor.closeBraces(),
  "ctrl+b": (editor) => (editor.wrap("<b>|</b>"), true),
  "ctrl+i": (editor) => (editor.wrap("<i>|</i>"), true),
  "ctrl+u": (editor) => (editor.wrap("<u>|</u>"), true),
};

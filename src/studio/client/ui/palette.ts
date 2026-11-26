/** Paleta de comandos (Ctrl+K) e tela de atalhos (F1), as duas lidas do registro de ações. */
import { listActions, type Action } from "./actions";
import { byId, h, inputById, openDialog } from "./dom";

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const keysLabel = (keys: string) =>
  h("span", {}, ...keys.split("+").map((key) => h("kbd", { text: key })));

export class Palette {
  private readonly dialog = byId<HTMLDialogElement>("palette");
  private readonly input = inputById("paletteInput");
  private readonly list = byId("paletteList");
  private items: Action[] = [];
  private active = 0;

  constructor() {
    this.input.addEventListener("input", () => this.filter());
    this.input.addEventListener("keydown", (event) => this.onKey(event));
    this.dialog.addEventListener("click", (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
  }

  open(): void {
    this.input.value = "";
    this.filter();
    openDialog("palette");
    this.input.focus();
  }

  private filter(): void {
    const terms = normalize(this.input.value).split(/\s+/).filter(Boolean);
    this.items = listActions().filter((action) => {
      const text = normalize(`${action.group} ${action.label}`);
      return terms.every((term) => text.includes(term));
    });
    this.active = 0;
    this.render();
  }

  private render(): void {
    this.list.replaceChildren(
      ...this.items.map((action, index) =>
        h(
          "li",
          {
            class: index === this.active ? "active" : "",
            attrs: { role: "option" },
            on: { click: () => this.run(index) },
          },
          h("span", { class: "group", text: action.group }),
          h("span", { class: "spacer", text: action.label }),
          action.keys ? keysLabel(action.keys) : null,
        ),
      ),
    );
    this.list.children[this.active]?.scrollIntoView({ block: "nearest" });
  }

  private run(index: number): void {
    const action = this.items[index];
    if (!action) return;
    this.dialog.close();
    void action.run();
  }

  private onKey(event: KeyboardEvent): void {
    const size = this.items.length || 1;
    const handlers: Record<string, () => void> = {
      ArrowDown: () => ((this.active = (this.active + 1) % size), this.render()),
      ArrowUp: () => ((this.active = (this.active - 1 + size) % size), this.render()),
      Enter: () => this.run(this.active),
    };
    const handler = handlers[event.key];
    if (!handler) return;
    event.preventDefault();
    handler();
  }
}

/** Atalhos que não são ações do registro: vivem no editor. */
const EDITOR_SHORTCUTS: readonly [string, string][] = [
  ["Ctrl+Espaço", "Sugerir campos e funções"],
  ["Tab", "Aumentar o recuo"],
  ["Shift+Tab", "Diminuir o recuo"],
  ["Ctrl+B", "Negrito"],
  ["Ctrl+I", "Itálico"],
  ["Ctrl+U", "Sublinhado"],
  ["Ctrl+/", "Comentar ou descomentar"],
  ["Ctrl+Z", "Desfazer, inclusive o que os assistentes inseriram"],
  ["{{", "Fecha as chaves e sugere os campos"],
];

export function openShortcuts(): void {
  const rows = [
    ...listActions()
      .filter((action) => action.keys)
      .map((action) => [action.keys!, action.label] as const),
    ...EDITOR_SHORTCUTS,
  ];
  byId("shortcutsTable").replaceChildren(
    ...rows.map(([keys, label]) =>
      h("tr", {}, h("td", {}, keysLabel(keys)), h("td", { text: label })),
    ),
  );
  openDialog("dlgShortcuts");
}

/**
 * Boot do Studio: monta os painéis, registra as ações (botões, atalhos e paleta saem daqui) e
 * restaura o trabalho salvo no navegador.
 */
import {
  bindActionButtons,
  defineActions,
  dispatchShortcut,
  runAction,
  type Action,
} from "./ui/actions";
import { fetchHelpers, fetchStarters } from "./ui/api";
import { CompletionPopup } from "./ui/completionPopup";
import { DataPanel } from "./ui/dataPanel";
import { Documents } from "./ui/documents";
import { bindDialogCloseButtons, byId, h, setStatus } from "./ui/dom";
import { Editor } from "./ui/editor";
import { FindBar } from "./ui/findBar";
import { iconSvg, renderIcons } from "./ui/icons";
import { openShortcuts, Palette } from "./ui/palette";
import { Preview } from "./ui/preview";
import { ProblemsPanel } from "./ui/problemsPanel";
import { on, restoreConnection, SAMPLE_DATA, setData, state } from "./ui/state";
import { readItem, readJson, writeItem } from "./ui/storage";
import { SystemPanel } from "./ui/system";
import { Wizards } from "./ui/wizards";

const FALLBACK_TEMPLATE = `<div style="font-family: Arial, sans-serif; padding: 24px; font-size: 13px;">
  <h1 style="margin: 4px 0;">{{titulo}}</h1>
  <p><small>Gerado em {{dateNow}}</small></p>
</div>`;

renderIcons();
bindDialogCloseButtons();
bindActionButtons();

const editor = new Editor();
const completion = new CompletionPopup(editor);
const findBar = new FindBar(editor);
const preview = new Preview(editor);
const problems = new ProblemsPanel(editor);
const wizards = new Wizards(editor);
const documents = new Documents(editor);
const system = new SystemPanel(editor, {
  docName: () => documents.docName,
  replaceContent: (content, name, reason) => documents.replaceContent(content, name, reason),
});
new DataPanel(editor, { onListPicked: (node) => wizards.openTable(node.path) });
const palette = new Palette();

// ── Ações ────────────────────────────────────────────────────────────────

function setView(view: string): void {
  byId("workspace").className = `view-${view}`;
  for (const button of document.querySelectorAll<HTMLElement>("#viewToggle .seg")) {
    button.classList.toggle("active", button.dataset.view === view);
  }
  writeItem("view", view);
}

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme;
  const button = document.querySelector('[data-action="toggle-theme"]');
  if (button) button.innerHTML = iconSvg(theme === "dark" ? "sun" : "moon");
  writeItem("theme", theme);
}

const ACTIONS: Action[] = [
  {
    id: "palette",
    group: "Geral",
    label: "Todos os comandos",
    keys: "Ctrl+K",
    run: () => palette.open(),
  },
  { id: "shortcuts", group: "Geral", label: "Atalhos do teclado", keys: "F1", run: openShortcuts },
  {
    id: "toggle-theme",
    group: "Geral",
    label: "Alternar tema claro e escuro",
    run: () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
  },
  {
    id: "starters",
    group: "Modelo",
    label: "Novo a partir de um modelo pronto",
    run: () => documents.openStarters(),
  },
  {
    id: "open-file",
    group: "Modelo",
    label: "Abrir arquivo .hbs",
    keys: "Ctrl+O",
    run: () => documents.openFile(),
  },
  {
    id: "download",
    group: "Modelo",
    label: "Baixar arquivo .hbs",
    run: () => documents.download(),
  },
  {
    id: "save-version",
    group: "Modelo",
    label: "Guardar versão",
    keys: "Ctrl+S",
    run: () => documents.saveVersionNow(),
  },
  {
    id: "versions",
    group: "Modelo",
    label: "Versões guardadas",
    run: () => documents.openVersions(),
  },
  {
    id: "find",
    group: "Editor",
    label: "Procurar e substituir",
    keys: "Ctrl+F",
    run: () => findBar.open(),
  },
  {
    id: "toggle-wrap",
    group: "Editor",
    label: "Quebrar linhas longas",
    keys: "Alt+Z",
    run: () => editor.toggleWrap(),
  },
  { id: "comment", group: "Editor", label: "Comentar trecho", run: () => editor.toggleComment() },
  { id: "bold", group: "Editor", label: "Negrito", run: () => editor.wrap("<b>|</b>") },
  { id: "italic", group: "Editor", label: "Itálico", run: () => editor.wrap("<i>|</i>") },
  { id: "underline", group: "Editor", label: "Sublinhado", run: () => editor.wrap("<u>|</u>") },
  {
    id: "suggest",
    group: "Editor",
    label: "Sugerir campos e funções",
    run: () => completion.update(false),
  },
  {
    id: "toggle-problems",
    group: "Editor",
    label: "Mostrar ou esconder Problemas",
    keys: "Ctrl+Shift+M",
    run: () => problems.toggle(),
  },
  {
    id: "wizard-table",
    group: "Assistentes",
    label: "Inserir tabela",
    keys: "Ctrl+Alt+T",
    run: () => wizards.openTable(),
  },
  {
    id: "wizard-group",
    group: "Assistentes",
    label: "Agrupar lista",
    keys: "Ctrl+Alt+G",
    run: () => wizards.openGroup(),
  },
  {
    id: "wizard-condition",
    group: "Assistentes",
    label: "Inserir condicional",
    keys: "Ctrl+Alt+C",
    run: () => wizards.openCondition(),
  },
  {
    id: "wizard-calc",
    group: "Assistentes",
    label: "Inserir cálculo",
    keys: "Ctrl+Alt+S",
    run: () => wizards.openCalc(),
  },
  {
    id: "edit-data",
    group: "Dados",
    label: "Colar ou editar os dados (JSON)",
    keys: "Ctrl+Shift+D",
    run: () => documents.openData(),
  },
  {
    id: "load-data",
    group: "Dados",
    label: "Recarregar os dados do sistema",
    keys: "Ctrl+Shift+L",
    run: () => void system.loadData(),
  },
  {
    id: "sample-data",
    group: "Dados",
    label: "Usar dados de exemplo",
    run: () => setData(SAMPLE_DATA),
  },
  {
    id: "connect",
    group: "Sistema",
    label: "Conectar ao sistema",
    run: () => system.openConnect(),
  },
  {
    id: "system-templates",
    group: "Sistema",
    label: "Modelos do sistema",
    run: () => void system.openTemplates(),
  },
  {
    id: "publish",
    group: "Sistema",
    label: "Publicar no sistema",
    keys: "Ctrl+Shift+S",
    run: () => system.openPublish(),
  },
  {
    id: "render",
    group: "Prévia",
    label: "Atualizar a prévia",
    keys: "Ctrl+Enter",
    run: () => void preview.render(),
  },
  {
    id: "pdf",
    group: "Prévia",
    label: "Gerar o PDF real",
    keys: "Ctrl+Shift+P",
    run: () => void preview.downloadPdf(documents.docName),
  },
  { id: "print", group: "Prévia", label: "Imprimir a prévia", run: () => preview.print() },
  {
    id: "toggle-guides",
    group: "Prévia",
    label: "Mostrar as quebras de página",
    run: () => preview.toggleGuides(),
  },
  {
    id: "view-editor",
    group: "Visualização",
    label: "Só o código",
    keys: "Ctrl+1",
    run: () => setView("editor"),
  },
  {
    id: "view-split",
    group: "Visualização",
    label: "Código e prévia",
    keys: "Ctrl+2",
    run: () => setView("split"),
  },
  {
    id: "view-preview",
    group: "Visualização",
    label: "Só a prévia",
    keys: "Ctrl+3",
    run: () => setView("preview"),
  },
];
defineActions(ACTIONS);

document.addEventListener("keydown", (event) => {
  const isPaletteOpen = byId<HTMLDialogElement>("palette").open;
  if (!isPaletteOpen) dispatchShortcut(event);
});

// Enter num campo de diálogo aciona o botão principal (sem isso o form fecha sem fazer nada).
document.addEventListener("keydown", (event) => {
  const field = event.target as HTMLElement;
  const isTextField = field instanceof HTMLInputElement && field.type !== "checkbox";
  const dialog = field.closest("dialog");
  if (event.key !== "Enter" || !isTextField || !dialog || dialog.id === "palette") return;
  event.preventDefault();
  dialog.querySelector<HTMLButtonElement>(".btn.primary")?.click();
});

// ── Barra de ferramentas ─────────────────────────────────────────────────

function closeMenus(): void {
  for (const menu of document.querySelectorAll(".menu.open")) menu.classList.remove("open");
}

document.addEventListener("click", (event) => {
  const target = event.target as Element;
  const wrapButton = target.closest<HTMLElement>("[data-wrap]");
  const insertButton = target.closest<HTMLElement>("[data-insert]");
  const menuButton = target.closest<HTMLElement>("[data-menu]");
  const viewButton = target.closest<HTMLElement>("[data-view]");
  if (wrapButton) editor.wrap(wrapButton.dataset.wrap ?? "|");
  if (insertButton) editor.insert(insertButton.dataset.insert ?? "");
  if (viewButton) setView(viewButton.dataset.view ?? "split");
  const menu = menuButton ? byId(menuButton.dataset.menu ?? "") : null;
  const wasOpen = menu?.classList.contains("open");
  closeMenus();
  if (menu && !wasOpen) menu.classList.add("open");
});

const CATEGORY_TITLES: Record<string, string> = {
  formato: "Formatação",
  calculo: "Cálculo",
  logica: "Lógica",
};

function renderHelpersMenu(): void {
  const categories = [...new Set(state.helpers.map((helper) => helper.category))];
  byId("mHelpers").replaceChildren(
    ...categories.flatMap((category) => [
      h("h5", { text: CATEGORY_TITLES[category] ?? category }),
      ...state.helpers
        .filter((helper) => helper.category === category)
        .map((helper) =>
          h(
            "button",
            { class: "mi", on: { click: () => editor.insert(helper.snippet) } },
            h("b", { text: helper.name }),
            h("small", { text: helper.description }),
            h("code", { text: helper.snippet }),
          ),
        ),
    ]),
  );
}

// ── Divisórias arrastáveis ───────────────────────────────────────────────

const SPLIT_LIMITS: Record<string, (x: number, bounds: DOMRect) => [string, string]> = {
  side: (x, bounds) => ["--side-w", `${Math.min(Math.max(x - bounds.left, 180), 520)}px`],
  preview: (x, bounds) => [
    "--preview-w",
    `${Math.min(Math.max(bounds.right - x, 320), bounds.width - 600)}px`,
  ],
};

function bindSplitters(): void {
  for (const splitter of document.querySelectorAll<HTMLElement>(".splitter")) {
    const limit = SPLIT_LIMITS[splitter.dataset.split ?? ""];
    if (!limit) continue;
    splitter.addEventListener("pointerdown", (start) => {
      splitter.setPointerCapture(start.pointerId);
      splitter.classList.add("dragging");
      // O iframe da prévia engole o ponteiro durante o arraste.
      byId("preview").style.pointerEvents = "none";
      const move = (event: PointerEvent) => {
        const [name, value] = limit(event.clientX, byId("workspace").getBoundingClientRect());
        document.documentElement.style.setProperty(name, value);
        writeItem(name, value);
      };
      const stop = () => {
        splitter.classList.remove("dragging");
        byId("preview").style.pointerEvents = "";
        splitter.removeEventListener("pointermove", move);
      };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", stop, { once: true });
    });
  }
  for (const name of ["--side-w", "--preview-w"]) {
    const saved = readItem(name);
    if (saved) document.documentElement.style.setProperty(name, saved);
  }
}

// ── Ligações entre os painéis ────────────────────────────────────────────

editor.onChange(() => {
  preview.schedule();
  problems.schedule();
});
editor.onCursor(() => {
  const { line, column } = editor.positionOf(editor.caret());
  byId("cursorPos").textContent = `Ln ${line}, Col ${column}`;
});
on("data", () => {
  const lists = state.lists.length;
  const fields = state.schema.length;
  byId("dataInfo").textContent = fields
    ? `Dados: ${fields} campo(s), ${lists} lista(s)`
    : "Sem dados";
  void preview.render();
  void problems.lint();
});

// ── Boot ─────────────────────────────────────────────────────────────────

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
applyTheme(readItem("theme", prefersDark ? "dark" : "light"));
setView(readItem("view", "split"));
bindSplitters();

const isFirstVisit = !readItem("template");
documents.restore(FALLBACK_TEMPLATE);
restoreConnection();
setData(readJson<unknown>("data", null) ?? SAMPLE_DATA);

void Promise.all([fetchHelpers(), fetchStarters()])
  .then(([helpers, starters]) => {
    state.helpers = helpers;
    state.starters = starters;
    renderHelpersMenu();
    if (isFirstVisit) runAction("starters");
  })
  .catch(() => setStatus("O servidor do Studio não respondeu", "err"));

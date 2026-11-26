/**
 * O documento em si: nome, autosave, modelos prontos, versões guardadas, abrir e baixar arquivo e
 * o diálogo de dados em JSON.
 */
import {
  byId,
  closeDialog,
  downloadBlob,
  h,
  inputById,
  openDialog,
  setError,
  textareaById,
  toast,
} from "./dom";
import type { Editor } from "./editor";
import { SAMPLE_DATA, setData, state } from "./state";
import { listVersions, readItem, removeVersion, saveVersion, writeItem } from "./storage";

const DEFAULT_NAME = "Relatório sem título";
const AUTOSAVE_DELAY_MS = 600;

export class Documents {
  private readonly name = inputById("docName");
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly editor: Editor) {
    this.name.addEventListener("input", () => writeItem("docName", this.name.value));
    editor.onChange(() => this.scheduleSave());
    byId("btnSaveVersion").addEventListener("click", () => {
      this.saveVersionNow();
      this.renderVersions();
    });
    byId("btnDownload").addEventListener("click", () => this.download());
    inputById("fileInput").addEventListener("change", () => void this.readFile());
    byId("btnJsonOk").addEventListener("click", () => this.applyJson());
    byId("btnJsonFormat").addEventListener("click", () => this.formatJson());
    byId("btnJsonSample").addEventListener("click", () => {
      textareaById("jsonInput").value = JSON.stringify(SAMPLE_DATA, null, 2);
    });
  }

  get docName(): string {
    return this.name.value.trim() || DEFAULT_NAME;
  }

  restore(fallbackTemplate: string): void {
    this.name.value = readItem("docName", DEFAULT_NAME);
    this.editor.textarea.value = readItem("template") || fallbackTemplate;
    this.editor.refresh();
  }

  private scheduleSave(): void {
    byId("saveState").textContent = "Salvando...";
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const saved = writeItem("template", this.editor.value);
      byId("saveState").textContent = saved
        ? "Salvo neste navegador"
        : "Não foi possível salvar neste navegador. Baixe o arquivo para não perder o trabalho.";
    }, AUTOSAVE_DELAY_MS);
  }

  saveVersionNow(): void {
    const saved = saveVersion(this.docName, this.editor.value, "Guardada por você");
    toast(saved ? "Versão guardada." : "Nada mudou desde a última versão.");
  }

  /** Troca o conteúdo guardando antes o atual, para nada se perder. */
  replaceContent(content: string, name: string, reason: string): void {
    saveVersion(this.docName, this.editor.value, reason);
    this.name.value = name;
    writeItem("docName", name);
    this.editor.setValue(content);
  }

  // ── Modelos prontos ─────────────────────────────────────────────────────

  openStarters(): void {
    byId("startersGrid").replaceChildren(
      ...state.starters.map((starter) =>
        h(
          "button",
          {
            class: "card",
            attrs: { type: "button" },
            on: {
              click: () => {
                this.replaceContent(
                  starter.template,
                  starter.name,
                  "Antes de começar um modelo novo",
                );
                if (hasOnlySampleData()) setData(starter.sampleData);
                closeDialog("dlgStarters");
                toast(`Modelo "${starter.name}" aberto.`);
              },
            },
          },
          h("b", { text: starter.name }),
          h("span", { text: starter.description }),
        ),
      ),
    );
    openDialog("dlgStarters");
  }

  // ── Versões ─────────────────────────────────────────────────────────────

  openVersions(): void {
    this.renderVersions();
    openDialog("dlgVersions");
  }

  private renderVersions(): void {
    const versions = listVersions();
    byId("versionsList").replaceChildren(
      ...(versions.length
        ? versions.map((version) =>
            h(
              "li",
              {},
              h(
                "div",
                { class: "spacer" },
                h("div", { class: "title", text: version.name }),
                h("div", {
                  class: "meta",
                  text: `${new Date(version.at).toLocaleString("pt-BR")} · ${version.reason} · ${version.content.length} caracteres`,
                }),
              ),
              h("button", {
                class: "btn small",
                text: "Restaurar",
                attrs: { type: "button" },
                on: {
                  click: () => {
                    this.replaceContent(
                      version.content,
                      version.name,
                      "Antes de restaurar uma versão",
                    );
                    closeDialog("dlgVersions");
                    toast("Versão restaurada. A anterior ficou guardada.");
                  },
                },
              }),
              h("button", {
                class: "icon-btn small",
                title: "Apagar esta versão",
                text: "✕",
                attrs: { type: "button" },
                on: {
                  click: () => {
                    removeVersion(version.id);
                    this.renderVersions();
                  },
                },
              }),
            ),
          )
        : [h("li", { class: "muted", text: "Nenhuma versão guardada ainda." })]),
    );
  }

  // ── Arquivo ─────────────────────────────────────────────────────────────

  openFile(): void {
    inputById("fileInput").click();
  }

  private async readFile(): Promise<void> {
    const input = inputById("fileInput");
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const name = file.name.replace(/\.[^.]+$/, "");
    this.replaceContent(await file.text(), name, "Antes de abrir um arquivo");
    toast(`Arquivo ${file.name} aberto.`);
  }

  download(): void {
    const blob = new Blob([this.editor.value], { type: "text/x-handlebars-template" });
    downloadBlob(blob, `${this.docName}.hbs`);
  }

  // ── Dados em JSON ───────────────────────────────────────────────────────

  openData(): void {
    setError("jsonError");
    const hasData = Object.keys((state.data ?? {}) as object).length > 0;
    textareaById("jsonInput").value = hasData ? JSON.stringify(state.data, null, 2) : "";
    openDialog("dlgData");
    textareaById("jsonInput").focus();
  }

  private parseJsonInput(): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(textareaById("jsonInput").value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      setError("jsonError", 'O JSON precisa começar com chaves, como {"itens": [...]}.');
    } catch (error) {
      setError("jsonError", `JSON inválido: ${(error as Error).message}`);
    }
    return null;
  }

  private formatJson(): void {
    const parsed = this.parseJsonInput();
    if (parsed) textareaById("jsonInput").value = JSON.stringify(parsed, null, 2);
  }

  private applyJson(): void {
    const parsed = this.parseJsonInput();
    if (!parsed) return;
    closeDialog("dlgData");
    setData(parsed);
    toast("Dados carregados.");
  }
}

/** Dados reais (colados ou do sistema) nunca são trocados pelos dados de exemplo de um modelo. */
function hasOnlySampleData(): boolean {
  const current = JSON.stringify(state.data ?? {});
  const samples = [SAMPLE_DATA, ...state.starters.map((starter) => starter.sampleData)];
  return current === "{}" || samples.some((sample) => JSON.stringify(sample) === current);
}

/**
 * Conversa com o sistema (rotas do createReportRouter, via proxy do servidor local): conexão,
 * dados reais, lista de modelos do relatório, ativação e publicação.
 */
import { appAction, describeFailure, type SystemTemplate } from "./api";
import {
  byId,
  closeDialog,
  h,
  inputById,
  openDialog,
  setError,
  setStatus,
  textareaById,
  toast,
  withBusyButton,
} from "./dom";
import type { Editor } from "./editor";
import { isConnected, on, setConnection, setData, state } from "./state";
import { saveVersion } from "./storage";

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const formatDate = (timestamp?: number) =>
  timestamp
    ? new Date(timestamp).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
    : "";

export interface SystemOptions {
  docName(): string;
  /** Troca o conteúdo do editor guardando antes a versão atual. */
  replaceContent(content: string, name: string, reason: string): void;
}

export class SystemPanel {
  constructor(
    private readonly editor: Editor,
    private readonly options: SystemOptions,
  ) {
    byId("btnLoad").addEventListener(
      "click",
      (event) =>
        void withBusyButton(event.currentTarget as HTMLButtonElement, () => this.saveAndLoad()),
    );
    byId("btnPublish").addEventListener(
      "click",
      (event) =>
        void withBusyButton(event.currentTarget as HTMLButtonElement, () => this.publish()),
    );
    byId("btnRestoreDefault").addEventListener("click", () => void this.activate(null));
    on("connection", () => this.renderConnection());
    this.renderConnection();
  }

  private renderConnection(): void {
    const { baseUrl, reportId } = state.connection;
    byId("connectLabel").textContent = isConnected() ? reportId : "Conectar ao sistema";
    byId("connectionInfo").textContent = isConnected()
      ? `Sistema: ${baseUrl} · ${reportId}`
      : "Sem conexão";
  }

  openConnect(): void {
    inputById("baseUrl").value = state.connection.baseUrl;
    inputById("reportId").value = state.connection.reportId;
    const headers = state.connection.headers;
    textareaById("headersJson").value = Object.keys(headers).length
      ? JSON.stringify(headers, null, 2)
      : "";
    textareaById("filtersJson").value = state.filters;
    setError("connectError");
    openDialog("dlgConnect");
  }

  private async saveAndLoad(): Promise<void> {
    const headers = parseJsonObject(textareaById("headersJson").value);
    const filters = parseJsonObject(textareaById("filtersJson").value);
    if (!headers || !filters) {
      setError(
        "connectError",
        'Cabeçalhos e filtros precisam ser um JSON de objeto, como {"chave": "valor"}.',
      );
      return;
    }
    const baseUrl = inputById("baseUrl").value.trim();
    const reportId = inputById("reportId").value.trim();
    if (!baseUrl || !reportId) {
      setError("connectError", "Informe o endereço e o relatório.");
      return;
    }
    const onlyText = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, String(value)]),
    );
    setConnection(
      { baseUrl, reportId, headers: onlyText },
      textareaById("filtersJson").value || "{}",
    );
    const loaded = await this.loadData((message) => setError("connectError", message));
    if (loaded) closeDialog("dlgConnect");
  }

  /** Busca os dados reais do relatório. Sem conexão, abre o diálogo de conexão. */
  async loadData(
    onError: (message: string) => void = (message) => toast(message, true),
  ): Promise<boolean> {
    if (!isConnected()) {
      this.openConnect();
      return false;
    }
    setStatus("Buscando dados no sistema", "busy");
    const filters = parseJsonObject(state.filters) ?? {};
    const result = await appAction<Record<string, unknown>>("data", state.connection, { filters });
    if (!result.ok) {
      setStatus("Os dados não vieram", "err");
      onError(describeFailure(result, "O sistema não devolveu os dados"));
      return false;
    }
    setData(result.body);
    setStatus("Dados do sistema carregados", "ok");
    toast("Dados do sistema carregados.");
    return true;
  }

  // ── Modelos do sistema ──────────────────────────────────────────────────

  async openTemplates(): Promise<void> {
    if (!isConnected()) {
      this.openConnect();
      return;
    }
    openDialog("dlgTemplates");
    await this.refreshTemplates();
  }

  private async refreshTemplates(): Promise<void> {
    byId("templatesInfo").textContent = `Relatório ${state.connection.reportId}`;
    setError("templatesError");
    byId("templatesList").replaceChildren(h("li", { class: "muted", text: "Carregando..." }));
    const result = await appAction<{ data?: SystemTemplate[] }>("templates", state.connection);
    if (!result.ok) {
      byId("templatesList").replaceChildren();
      setError("templatesError", describeFailure(result, "Os modelos não vieram"));
      return;
    }
    const templates = result.body.data ?? [];
    byId("templatesList").replaceChildren(
      ...(templates.length
        ? templates.map((template) => this.templateRow(template))
        : [h("li", { class: "muted", text: "Este relatório ainda usa só o modelo padrão." })]),
    );
  }

  private templateRow(template: SystemTemplate): HTMLElement {
    return h(
      "li",
      {},
      h(
        "div",
        { class: "spacer" },
        h("div", { class: "title", text: template.name }),
        h("div", { class: "meta", text: formatDate(template.createdAt) }),
      ),
      template.active ? h("span", { class: "pill", text: "Em uso" }) : null,
      h("button", {
        class: "btn small",
        text: "Abrir no editor",
        attrs: { type: "button" },
        on: {
          click: () => {
            this.options.replaceContent(
              template.content,
              template.name,
              "Antes de abrir um modelo do sistema",
            );
            closeDialog("dlgTemplates");
            toast(`Modelo "${template.name}" aberto.`);
          },
        },
      }),
      template.active
        ? null
        : h("button", {
            class: "btn small",
            text: "Usar no relatório",
            attrs: { type: "button" },
            on: { click: () => void this.activate(template.id) },
          }),
    );
  }

  private async activate(templateId: string | null): Promise<void> {
    const result = await appAction("activate-template", state.connection, { templateId });
    if (!result.ok) {
      setError("templatesError", describeFailure(result, "O modelo não foi ativado"));
      return;
    }
    toast(templateId ? "Modelo em uso no relatório." : "O relatório voltou ao modelo padrão.");
    await this.refreshTemplates();
  }

  // ── Publicar ────────────────────────────────────────────────────────────

  openPublish(): void {
    if (!isConnected()) {
      this.openConnect();
      return;
    }
    byId("publishTarget").textContent =
      `Relatório ${state.connection.reportId} em ${state.connection.baseUrl}`;
    inputById("publishName").value = this.options.docName();
    const errors = state.problems.filter((p) => p.severity === "error").length;
    byId("publishWarning").textContent = errors
      ? `O modelo tem ${errors} erro(s) no painel Problemas. Corrija antes de publicar.`
      : "";
    setError("publishError");
    openDialog("dlgPublish");
  }

  private async publish(): Promise<void> {
    const name = inputById("publishName").value.trim() || this.options.docName();
    const content = this.editor.value;
    const result = await appAction<{ data?: { id?: string } }>("save-template", state.connection, {
      name,
      content,
    });
    if (!result.ok) {
      setError("publishError", describeFailure(result, "O modelo não foi publicado"));
      return;
    }
    saveVersion(name, content, "Publicado no sistema");
    const id = result.body.data?.id;
    const activation =
      inputById("publishActivate").checked && id
        ? await appAction("activate-template", state.connection, { templateId: id })
        : null;
    closeDialog("dlgPublish");
    setStatus("Modelo publicado", "ok");
    if (activation && !activation.ok) {
      toast("Modelo publicado, mas não foi colocado em uso. Ative em Modelos do sistema.", true);
      return;
    }
    toast(activation ? "Modelo publicado e em uso no relatório." : "Modelo publicado no sistema.");
  }
}

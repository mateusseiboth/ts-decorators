/**
 * Prévia em folha de papel: renderiza no servidor (mesmos helpers do PDF), ajusta a altura do
 * iframe ao conteúdo, mostra as quebras de página e conta as páginas. O PDF real sai pelo mesmo
 * Chromium do worker.
 */
import { renderPreview, requestPdf } from "./api";
import { byId, downloadBlob, selectById, setStatus, toast } from "./dom";
import type { Editor } from "./editor";
import { state } from "./state";
import { readItem, writeItem } from "./storage";

/** Tamanho da folha em px a 96 dpi (retrato). */
const PAPER_SIZES: Record<string, readonly [number, number]> = {
  A4: [794, 1123],
  A3: [1123, 1587],
  A5: [559, 794],
  Letter: [816, 1056],
  Legal: [816, 1344],
};

const RENDER_DELAY_MS = 300;

export class Preview {
  private readonly iframe = byId<HTMLIFrameElement>("preview");
  private readonly paper = byId("paper");
  private readonly frame = byId("paperFrame");
  private readonly scroller = byId("paperScroll");
  private readonly guides = byId("pageGuides");
  private readonly error = byId("renderError");
  private readonly format = selectById("pageFormat");
  private readonly orientation = selectById("orientation");
  private readonly zoom = selectById("zoom");
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;
  private contentHeight = 0;
  private readonly renderedListeners: (() => void)[] = [];

  constructor(private readonly editor: Editor) {
    this.format.value = readItem("pageFormat", "A4");
    this.orientation.value = readItem("orientation", "portrait");
    this.zoom.value = readItem("zoom", "fit");
    this.guides.classList.toggle("on", readItem("guides", "1") === "1");
    for (const select of [this.format, this.orientation, this.zoom]) {
      select.addEventListener("change", () => {
        writeItem(select.id, select.value);
        this.layout();
      });
    }
    this.iframe.addEventListener("load", () => this.measure());
    new ResizeObserver(() => this.layout()).observe(this.scroller);
    this.error.addEventListener("click", () => {
      const line = Number(this.error.dataset.line);
      if (line) editor.goTo({ line, column: 1 });
    });
  }

  onRendered(listener: () => void): void {
    this.renderedListeners.push(listener);
  }

  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.render(), RENDER_DELAY_MS);
  }

  async render(): Promise<void> {
    const sequence = ++this.sequence;
    setStatus("Atualizando a prévia", "busy");
    try {
      const result = await renderPreview({ template: this.editor.value, data: state.data });
      if (sequence !== this.sequence) return;
      if (!result.ok) {
        this.showError(result.body.message ?? "Erro no modelo.", result.body.line);
        return;
      }
      this.error.hidden = true;
      this.iframe.srcdoc = result.body.html;
      byId("renderTime").textContent = `Prévia em ${result.body.ms} ms`;
      setStatus("Prévia atualizada", "ok");
    } catch (error) {
      setStatus(`O servidor do Studio não respondeu. ${(error as Error).message}`, "err");
    }
    for (const listener of this.renderedListeners) listener();
  }

  toggleGuides(): void {
    const isOn = this.guides.classList.toggle("on");
    writeItem("guides", isOn ? "1" : "0");
  }

  print(): void {
    this.iframe.contentWindow?.print();
  }

  async downloadPdf(name: string): Promise<void> {
    setStatus("Gerando o PDF", "busy");
    const result = await requestPdf({
      template: this.editor.value,
      data: state.data,
      pageFormat: this.format.value,
      landscape: this.orientation.value === "landscape",
    });
    if (!(result instanceof Blob)) {
      setStatus("O PDF não foi gerado", "err");
      toast(result.message, true);
      return;
    }
    const url = URL.createObjectURL(result);
    const opened = window.open(url, "_blank");
    if (!opened) downloadBlob(result, `${name || "relatorio"}.pdf`);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setStatus("PDF gerado", "ok");
  }

  private showError(message: string, line?: number): void {
    this.error.textContent = line ? `Linha ${line}: ${message}` : message;
    this.error.dataset.line = String(line ?? "");
    this.error.hidden = false;
    setStatus("Erro no modelo", "err");
  }

  private pageSize(): readonly [number, number] {
    const [width, height] = PAPER_SIZES[this.format.value] ?? PAPER_SIZES.A4!;
    return this.orientation.value === "landscape" ? [height, width] : [width, height];
  }

  private measure(): void {
    const document = this.iframe.contentDocument;
    this.contentHeight = document?.documentElement.scrollHeight ?? 0;
    this.layout();
  }

  private layout(): void {
    const [width, pageHeight] = this.pageSize();
    const height = Math.max(pageHeight, this.contentHeight);
    const pages = Math.max(1, Math.ceil((height - 1) / pageHeight));
    const available = this.scroller.clientWidth - 48;
    const scale =
      this.zoom.value === "fit"
        ? Math.min(1.5, Math.max(0.3, available / width))
        : Number(this.zoom.value);

    this.paper.style.width = `${width}px`;
    this.iframe.style.height = `${height}px`;
    this.paper.style.height = `${height}px`;
    this.paper.style.transform = `scale(${scale})`;
    this.frame.style.width = `${width * scale}px`;
    this.frame.style.height = `${height * scale}px`;

    this.guides.replaceChildren(
      ...Array.from({ length: pages - 1 }, (_, index) => {
        const guide = document.createElement("div");
        guide.style.top = `${(index + 1) * pageHeight}px`;
        const label = document.createElement("span");
        label.textContent = `Página ${index + 2}`;
        guide.append(label);
        return guide;
      }),
    );
    byId("pageCount").textContent = pages === 1 ? "1 página" : `${pages} páginas`;
  }
}

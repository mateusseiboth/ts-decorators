/**
 * PDF real da prévia, pelo mesmo Chromium (playwright) e as mesmas opções de página do worker.
 * O playwright é peer opcional: sem ele instalado, o Studio segue funcionando e só o botão de PDF
 * avisa o que fazer. O navegador sobe na primeira chamada e fica quente até o Studio parar.
 */
import type { Browser } from "playwright";

import type { ReportPageFormat } from "../report/types";
import { buildPdfOptions } from "../report/worker/pdfOptions";

export interface StudioPdfOptions {
  pageFormat: ReportPageFormat;
  landscape: boolean;
}

export type StudioPdfRenderer = (html: string, options: StudioPdfOptions) => Promise<Uint8Array>;

export class StudioPdfUnavailableError extends Error {
  constructor() {
    super("Para gerar o PDF, instale o playwright no projeto: bun add -d playwright.");
    this.name = "StudioPdfUnavailableError";
  }
}

const PAGE_FORMATS: ReadonlySet<string> = new Set<ReportPageFormat>([
  "Letter",
  "Legal",
  "Tabloid",
  "Ledger",
  "A0",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
]);

export function parsePdfOptions(body: Record<string, unknown>): StudioPdfOptions {
  const format = typeof body.pageFormat === "string" ? body.pageFormat : "";
  return {
    pageFormat: PAGE_FORMATS.has(format) ? (format as ReportPageFormat) : "A4",
    landscape: body.landscape === true,
  };
}

async function launchChromium(): Promise<Browser> {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch();
  } catch {
    throw new StudioPdfUnavailableError();
  }
}

export interface ChromiumPdfRenderer {
  render: StudioPdfRenderer;
  close(): Promise<void>;
}

export function createChromiumPdfRenderer(): ChromiumPdfRenderer {
  let browser: Promise<Browser> | null = null;
  const readBrowser = () => {
    browser ??= launchChromium().catch((error: unknown) => {
      browser = null;
      throw error;
    });
    return browser;
  };

  return {
    async render(html, { pageFormat, landscape }) {
      const page = await (await readBrowser()).newPage();
      try {
        await page.setContent(html, { waitUntil: "networkidle" });
        const options = buildPdfOptions({
          disableHeaderFooter: true,
          headerHTML: "",
          footerHTML: "",
          pageFormat,
        });
        return await page.pdf({ ...options, landscape, printBackground: true });
      } finally {
        await page.close();
      }
    },
    async close() {
      const current = browser;
      browser = null;
      await (await current?.catch(() => null))?.close();
    },
  };
}

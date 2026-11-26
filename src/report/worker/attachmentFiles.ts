/**
 * O arquivo de um PDF anexado, pronto para o `pdfunite`. Anexo que não abre como PDF (sumiu,
 * corrompido, criptografado) fica de fora: o relatório sai sem ele, com o motivo no log, em vez de
 * derrubar o merge inteiro. `maxPages` corta nas primeiras páginas, numa cópia temporária no
 * `outputDir` do job (a varredura do job a remove).
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";

import { PDFDocument } from "pdf-lib";

import type { ReportPdfAttachment } from "./pdfAttachments";

export interface PreparedAttachment {
  path: string;
  /** Cópia criada aqui: a engine apaga ao terminar. */
  temporary: boolean;
}

let sequencia = 0;

async function loadPdf(arquivo: string): Promise<PDFDocument | null> {
  try {
    return await PDFDocument.load(readFileSync(arquivo), { updateMetadata: false });
  } catch (erro) {
    console.warn(
      `[REPORT:ANEXO] ${arquivo} não entrou no relatório: ${(erro as Error)?.message ?? erro}`,
    );
    return null;
  }
}

async function writeFirstPages(
  doc: PDFDocument,
  paginas: number,
  outputDir: string,
  jobId: string,
): Promise<string> {
  const copia = await PDFDocument.create();
  const indices = Array.from({ length: paginas }, (_, indice) => indice);
  for (const pagina of await copia.copyPages(doc, indices)) copia.addPage(pagina);
  sequencia += 1;
  const destino = path.join(outputDir, `${jobId}.anexo${sequencia}.pdf`);
  writeFileSync(destino, await copia.save());
  return destino;
}

export async function prepareAttachmentFile(
  anexo: ReportPdfAttachment,
  outputDir: string,
  jobId: string,
): Promise<PreparedAttachment | null> {
  const doc = await loadPdf(anexo.path);
  if (!doc) return null;
  const teto = Number(anexo.maxPages);
  const isCortado = Number.isFinite(teto) && teto > 0 && doc.getPageCount() > teto;
  if (!isCortado) return { path: anexo.path, temporary: false };
  return {
    path: await writeFirstPages(doc, Math.floor(teto), outputDir, jobId),
    temporary: true,
  };
}

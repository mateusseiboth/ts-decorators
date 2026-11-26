/**
 * O arquivo de cada anexo antes do merge: PDF que não abre fica de fora (o relatório sai sem ele,
 * com log), e `maxPages` corta nas primeiras páginas, numa cópia temporária.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { PDFDocument } from "pdf-lib";

import { prepareAttachmentFile } from "../src/report/worker/attachmentFiles";

const pasta = () => mkdtempSync(path.join(tmpdir(), "bc-anexo-"));

async function writePdf(dir: string, paginas: number): Promise<string> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) doc.addPage([200, 200]);
  const destino = path.join(dir, `doc-${paginas}.pdf`);
  writeFileSync(destino, await doc.save());
  return destino;
}

const countPaginas = async (arquivo: string) =>
  (await PDFDocument.load(readFileSync(arquivo))).getPageCount();

describe("prepareAttachmentFile", () => {
  test("PDF válido sem teto: entra o próprio arquivo", async () => {
    const dir = pasta();
    const origem = await writePdf(dir, 3);

    const pronto = await prepareAttachmentFile({ path: origem, placement: "end" }, dir, "job");

    expect(pronto).toEqual({ path: origem, temporary: false });
  });

  test("maxPages menor que o PDF: cópia temporária só com as primeiras páginas", async () => {
    const dir = pasta();
    const origem = await writePdf(dir, 5);

    const pronto = await prepareAttachmentFile(
      { path: origem, placement: "after-group", maxPages: 2 },
      dir,
      "job",
    );

    expect(pronto?.path).not.toBe(origem);
    expect(pronto?.temporary).toBe(true);
    expect(await countPaginas(pronto!.path)).toBe(2);
    expect(await countPaginas(origem)).toBe(5);
  });

  test("maxPages maior ou igual ao PDF: entra o próprio arquivo", async () => {
    const dir = pasta();
    const origem = await writePdf(dir, 2);

    const pronto = await prepareAttachmentFile(
      { path: origem, placement: "end", maxPages: 2 },
      dir,
      "job",
    );

    expect(pronto).toEqual({ path: origem, temporary: false });
  });

  test("arquivo que não existe ou não é PDF fica de fora", async () => {
    const dir = pasta();
    const lixo = path.join(dir, "lixo.pdf");
    writeFileSync(lixo, "isto não é um PDF");

    expect(await prepareAttachmentFile({ path: lixo, placement: "end" }, dir, "job")).toBeNull();
    expect(
      await prepareAttachmentFile(
        { path: path.join(dir, "sumiu.pdf"), placement: "end" },
        dir,
        "job",
      ),
    ).toBeNull();
  });
});

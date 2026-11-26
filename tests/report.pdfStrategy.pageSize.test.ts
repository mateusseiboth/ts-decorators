/** A strategy do PDF repassa o tamanho da página ao worker, que é quem chama o `page.pdf()`. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { PdfOutputStrategy } from "../src/report/formats/PdfOutputStrategy";
import type { ReportOutputContext } from "../src/report/types";
import type {
  ReportWorkerManager,
  ReportWorkerPayload,
} from "../src/report/worker/ReportWorkerManager";

const VIEWS_ROOT = path.join(import.meta.dir, "fixtures", "views");

async function readPayload(extra: Partial<ReportOutputContext>): Promise<ReportWorkerPayload> {
  let payload: ReportWorkerPayload | undefined;
  const manager = {
    generate: async (recebido: ReportWorkerPayload) => {
      payload = recebido;
      return { parts: 1, bytes: 1 };
    },
  } as unknown as ReportWorkerManager;
  const outputDir = mkdtempSync(path.join(tmpdir(), "bc-pdf-page-"));

  await new PdfOutputStrategy(() => manager).generate({
    job: { id: "job-1", definition: { title: "Demo" }, filters: {} },
    data: [],
    viewsRoot: VIEWS_ROOT,
    viewDir: path.join(VIEWS_ROOT, "demo"),
    outputDir,
    partialsDir: path.join(VIEWS_ROOT, "partials"),
    assinaturas: [],
    onProgress: () => undefined,
    ...extra,
  } as unknown as ReportOutputContext);

  return payload!;
}

describe("PdfOutputStrategy: tamanho da página", () => {
  test("sem as opções, o worker recebe A4 e preferCSSPageSize false", async () => {
    const payload = await readPayload({});
    expect(payload.pageFormat).toBe("A4");
    expect(payload.preferCSSPageSize).toBe(false);
  });

  test("com as opções, o worker recebe o que veio no contexto", async () => {
    const payload = await readPayload({ pageFormat: "Legal", preferCSSPageSize: true });
    expect(payload.pageFormat).toBe("Legal");
    expect(payload.preferCSSPageSize).toBe(true);
  });
});

describe("PdfOutputStrategy: PDFs anexados", () => {
  test("o anexo after-group corta a parte, e o plano vai pronto ao worker em streaming", async () => {
    const data = [
      { id: "A", anexos: [{ path: "/crlv-a.pdf", placement: "after-group" }] },
      { id: "B" },
      { id: "C", anexos: [{ path: "/fecho.pdf", placement: "end" }] },
    ];
    const payload = await readPayload({ data, viewDir: path.join(VIEWS_ROOT, "anexos") });

    expect(payload.pageFiles).toHaveLength(2);
    expect(payload.attachmentPlan?.afterPart.map((lista) => lista.map((a) => a.path))).toEqual([
      ["/crlv-a.pdf"],
      [],
    ]);
    expect(payload.attachmentPlan?.end.map((a) => a.path)).toEqual(["/fecho.pdf"]);
  });

  test("view sem getPdfAttachments: nenhum plano de anexos", async () => {
    const payload = await readPayload({});
    expect(payload.attachmentPlan).toBeUndefined();
  });
});

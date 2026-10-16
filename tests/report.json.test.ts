import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { JsonOutputStrategy } from "../src/report/formats/JsonOutputStrategy";
import { loadReportViewModel } from "../src/report/formats/viewModel";
import type { ReportOutputContext } from "../src/report/types";

const VIEWS_ROOT = path.join(import.meta.dir, "fixtures", "views");

function ctx(viewDir: string, data: unknown): ReportOutputContext {
  return {
    job: {
      id: "job-json",
      definition: { id: "d1", title: "Demo", tag: "1", model_tag: "26", view_path: "demo" },
      filters: {},
      exercicio: 2026,
      format: "json",
      user: { id: "u1", username: "X", entidade: 4 },
    },
    data,
    viewsRoot: VIEWS_ROOT,
    viewDir,
    outputDir: mkdtempSync(path.join(tmpdir(), "bc-json-")),
    partialsDir: path.join(VIEWS_ROOT, "partials"),
    assinaturas: [],
    onProgress: () => undefined,
  };
}

describe("JsonOutputStrategy — dados TRATADOS, sem fallback", () => {
  test("serializa o viewModel do main.ts (mesmo tratamento do PDF)", async () => {
    const strategy = new JsonOutputStrategy();
    const context = ctx(path.join(VIEWS_ROOT, "demo"), [
      { nome: "A", valor: 10 },
      { nome: "B", valor: 2.5 },
    ]);

    const result = await strategy.generate(context);
    expect(result.contentType).toBe("application/json");

    const body = JSON.parse(readFileSync(path.join(context.outputDir, result.file), "utf-8"));
    // Vem TRATADO (agrupado/formatado pelo buildReportData), não cru.
    expect(body.total).toBe(12.5);
    expect(body.items[0].valorFormatado).toBe("R$ 10.00");
  });

  test("view SEM main.ts/buildReportData falha com erro claro (nunca dado cru)", async () => {
    const strategy = new JsonOutputStrategy();
    const context = ctx(path.join(VIEWS_ROOT, "semmain"), [{ nome: "A" }]);

    await expect(strategy.generate(context)).rejects.toThrow(/buildReportData é obrigatório/);
  });

  test("loadReportViewModel é a fonte única (rota /data usa a mesma transformação)", async () => {
    const viewModel: any = await loadReportViewModel({
      viewDir: path.join(VIEWS_ROOT, "demo"),
      rows: [{ nome: "C", valor: 1 }],
      filters: {},
      title: "Via /data",
      exercicio: 2026,
    });
    expect(viewModel.title).toBe("Via /data");
    expect(viewModel.items.length).toBe(1);
  });
});

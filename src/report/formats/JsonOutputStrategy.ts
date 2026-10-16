import { statSync, writeFileSync } from "fs";
import path from "path";

import { buildOrderByFunction } from "../orderBy";
import type { ReportOutputContext, ReportOutputStrategy, ReportResult } from "../types";
import { loadReportViewModel } from "./viewModel";

/**
 * JSON — entrega o viewModel TRATADO da view (o MESMO que alimenta o template do
 * PDF), serializado. SEM fallback: view sem main.ts/buildReportData falha o job
 * com erro claro — nunca entregar dado cru.
 *
 * Roda na main thread (sem worker/Chromium).
 */
export class JsonOutputStrategy implements ReportOutputStrategy {
  readonly format = "json";
  readonly contentType = "application/json";
  readonly fileExtension = "json";

  async generate(ctx: ReportOutputContext): Promise<ReportResult> {
    const startedAt = Date.now();

    const viewModel = await loadReportViewModel({
      viewDir: ctx.viewDir,
      rows: ctx.data,
      filters: ctx.job.filters,
      title: ctx.job.definition.title,
      exercicio: ctx.job.exercicio,
      orderByFunction: buildOrderByFunction(ctx.job.filters),
    });
    ctx.data = undefined;

    ctx.onProgress({
      phase: "generating",
      current: 1,
      total: 1,
      percent: 100,
      message: "Serializando dados do relatório",
    });

    const filePath = path.join(ctx.outputDir, `${ctx.job.id}.json`);
    writeFileSync(
      filePath,
      JSON.stringify(viewModel, (_key, value) =>
        typeof value === "bigint" ? Number(value) : value,
      ),
    );

    return {
      file: `${ctx.job.id}.json`,
      contentType: this.contentType,
      parts: 1,
      bytes: statSync(filePath).size,
      durationMs: Date.now() - startedAt,
    };
  }
}

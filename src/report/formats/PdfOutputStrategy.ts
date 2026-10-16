import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

import type { ReportOutputContext, ReportOutputStrategy, ReportResult } from "../types";
import { planReportBatches, type ReportBatchWeight } from "../worker/reportBatch";
import type { ReportWorkerManager, ReportWorkerPayload } from "../worker/ReportWorkerManager";

/**
 * PDF — delega ao worker persistente (Chromium quente). O manager chega por
 * getter para nascer sob demanda (warmupWorker:false não sobe Chrome à toa).
 */
export class PdfOutputStrategy implements ReportOutputStrategy {
  readonly format = "pdf";
  readonly contentType = "application/pdf";
  readonly fileExtension = "pdf";

  constructor(private readonly getWorkerManager: () => ReportWorkerManager) {}

  async generate(ctx: ReportOutputContext): Promise<ReportResult> {
    const startedAt = Date.now();
    const renderModulePath = path.join(ctx.viewDir, "render.ts");
    const payload: ReportWorkerPayload = {
      jobId: ctx.job.id,
      data: ctx.data,
      title: ctx.job.definition.title,
      header: ctx.header ?? {},
      assinaturas: ctx.assinaturas,
      filters: ctx.job.filters,
      renderModulePath,
      partialsDir: ctx.partialsDir,
      outputDir: ctx.outputDir,
      templateSource: ctx.templateSource,
      viewSetupModule: ctx.viewSetupModule,
    };

    // STREAMING de dados: se o relatório bateia, o main já fatia as linhas em arquivos de página
    // no disco e calcula o total geral aqui (reusa computeTotals). Assim o worker lê 1 página por
    // vez (memória constante) e o postMessage não carrega GBs. Sem streaming → caminho em memória.
    await this.maybeStreamToPages(ctx, payload, renderModulePath);

    // A partir daqui o worker assume a posse dos dados — evita manter a coleção
    // duplicada na main thread durante todos os lotes e a mesclagem final.
    ctx.data = undefined;

    const { parts, bytes } = await this.getWorkerManager().generate(payload, ctx.onProgress);
    return {
      file: `${ctx.job.id}.pdf`,
      contentType: this.contentType,
      parts,
      bytes,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Fatia as linhas em arquivos de página no disco (um por parte, mesmo plano de peso do worker)
   * e pré-calcula o total geral. Só para relatórios que BATEIAM (mais de uma parte e sem opt-out).
   * Desligável por env `REPORT_STREAM_PAGES=false`. Best-effort: qualquer falha cai no caminho atual.
   */
  private async maybeStreamToPages(
    ctx: ReportOutputContext,
    payload: ReportWorkerPayload,
    renderModulePath: string,
  ): Promise<void> {
    if (process.env.REPORT_STREAM_PAGES === "false") return;
    const raw = ctx.data as any;
    const rows: unknown[] | null = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data)
        ? raw.data
        : null;
    if (!rows || rows.length === 0) return;

    let mod: any;
    try {
      mod = await import(renderModulePath);
    } catch {
      return; // sem o módulo, segue no caminho em memória
    }
    if (mod?.SUPPORTS_BATCHING === false) return; // opt-out (total geral não-bateável) → passada única

    const getWeight: ReportBatchWeight =
      typeof mod?.getBatchWeight === "function" ? mod.getBatchWeight : () => 1;
    const maxWeight = Math.max(
      1,
      Number(process.env.REPORT_BATCH_MAX_WEIGHT) ||
        Number(process.env.REPORT_BATCH_SIZE) ||
        Number(mod?.BATCH_MAX_WEIGHT) ||
        400,
    );
    const ranges = planReportBatches(rows, maxWeight, getWeight);
    if (ranges.length <= 1) return; // cabe em 1 parte → passada única (numeração nativa do Chromium)

    if (!existsSync(ctx.outputDir)) mkdirSync(ctx.outputDir, { recursive: true });
    const pageFiles: string[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i]!;
      const filePath = path.join(ctx.outputDir, `${ctx.job.id}.page${i}.json`);
      writeFileSync(filePath, JSON.stringify(rows.slice(range.start, range.end)));
      pageFiles.push(filePath);
    }
    payload.totals = typeof mod?.computeTotals === "function" ? mod.computeTotals(rows) : undefined;
    payload.pageFiles = pageFiles;
    payload.data = undefined; // não envia os dados pelo postMessage
  }
}

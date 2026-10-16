import { existsSync } from "fs";
import path from "path";

import type { ReportMainModule } from "../types";

/**
 * Carrega o main.ts da view e aplica `buildReportData` — a transformação/
 * agrupamento que também alimenta o template do PDF. É a fonte única do
 * viewModel para JSON/XLSX e para a rota síncrona /data (Studio).
 *
 * SEM fallback: view sem buildReportData é erro de contrato.
 */
export async function loadReportViewModel(options: {
  viewDir: string;
  rows: unknown;
  filters: any;
  title: string;
  exercicio: number;
  orderByFunction?: (a: any, b: any) => number;
}): Promise<unknown> {
  const mainPathTs = path.join(options.viewDir, "main.ts");
  const mainPathJs = path.join(options.viewDir, "main.js");
  const mainPath = existsSync(mainPathTs) ? mainPathTs : mainPathJs;
  if (!existsSync(mainPath)) {
    throw new Error(
      `A view "${options.viewDir}" não possui main.ts — buildReportData é obrigatório para dados tratados (JSON/Studio).`,
    );
  }

  const mainModule = (await import(mainPath)) as Partial<ReportMainModule>;
  if (typeof mainModule.buildReportData !== "function") {
    throw new Error(
      `A view "${options.viewDir}" não expõe buildReportData — obrigatório para dados tratados (JSON/Studio).`,
    );
  }

  return mainModule.buildReportData({
    rows: options.rows,
    filters: options.filters,
    title: options.title,
    exercicio: options.exercicio,
    orderByFunction: options.orderByFunction,
  });
}

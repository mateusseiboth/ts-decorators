import path from "path";

import type { ReportFormatRegistry } from "./formats/OutputStrategy";
import { loadReportViewModel } from "./formats/viewModel";
import { buildOrderByFunction } from "./orderBy";
import type {
  ReportAssinatura,
  ReportHeader,
  ReportJobPayload,
  ReportPageFormat,
  ReportProgress,
  ReportResult,
  ReportTemplateStore,
} from "./types";

export interface ReportProcessorDeps {
  viewsRoot: string;
  outputDir: string;
  partialsDir: string;
  viewSetupModule?: string;
  pageFormat: ReportPageFormat;
  preferCSSPageSize: boolean;
  resolveDataSource: import("./types").ReportDataSourceResolver;
  runInContext: <T>(job: ReportJobPayload, fn: () => Promise<T>) => Promise<T>;
  provideHeader?: (job: ReportJobPayload) => Promise<ReportHeader | undefined>;
  provideAssinaturas?: (job: ReportJobPayload) => Promise<ReportAssinatura[]>;
  resolveView: (viewPath: string, job: ReportJobPayload) => string;
  templateStore: ReportTemplateStore;
  formats: ReportFormatRegistry;
}

/**
 * Processa UM job: reidrata o contexto do app → busca os dados na fonte
 * resolvida (service/DAO) → pós-processa → header/assinaturas → despacha para
 * a strategy do formato (PDF via worker, JSON na main thread…).
 */
export class ReportProcessor {
  constructor(private readonly deps: ReportProcessorDeps) {}

  async process(
    job: ReportJobPayload,
    onProgress: (progress: ReportProgress) => void,
  ): Promise<ReportResult> {
    return this.deps.runInContext(job, async () => {
      const data = await this.fetchData(job);
      const [header, assinaturas] = await Promise.all([
        this.deps.provideHeader?.(job),
        this.deps.provideAssinaturas?.(job) ?? Promise.resolve([]),
      ]);
      const template = await this.deps.templateStore.getActive(job.definition.id);

      const strategy = this.deps.formats.get(job.format);
      return strategy.generate({
        job,
        data,
        viewsRoot: this.deps.viewsRoot,
        viewDir: this.resolveViewDir(job),
        outputDir: this.deps.outputDir,
        partialsDir: this.deps.partialsDir,
        header,
        assinaturas,
        templateSource: template?.content,
        viewSetupModule: this.deps.viewSetupModule,
        pageFormat: this.deps.pageFormat,
        preferCSSPageSize: this.deps.preferCSSPageSize,
        onProgress,
      });
    });
  }

  /**
   * Dados TRATADOS da view (buildReportData) sem gerar arquivo — fonte única da
   * rota síncrona /data (Studio) e da JsonOutputStrategy.
   */
  async buildViewModel(job: ReportJobPayload): Promise<unknown> {
    return this.deps.runInContext(job, async () => {
      const data = await this.fetchData(job);
      return loadReportViewModel({
        viewDir: this.resolveViewDir(job),
        rows: data,
        filters: job.filters,
        title: job.definition.title,
        exercicio: job.exercicio,
        orderByFunction: buildOrderByFunction(job.filters),
      });
    });
  }

  private resolveViewDir(job: ReportJobPayload): string {
    const relative = this.deps.resolveView(job.definition.view_path, job);
    return path.join(this.deps.viewsRoot, relative);
  }

  private async fetchData(job: ReportJobPayload): Promise<unknown> {
    const source = await this.deps.resolveDataSource(job.definition.model_tag, job);
    if (typeof source?.report !== "function") {
      throw new Error(
        `A fonte de dados da model_tag "${job.definition.model_tag}" não possui o método report().`,
      );
    }

    const data = await source.report(
      job.filters,
      job.definition.tag,
      job.user.entidade,
      job.exercicio,
    );
    if (typeof source.posProcessReportData !== "function") return data;
    return source.posProcessReportData(
      data,
      job.filters,
      job.definition.tag,
      job.user.entidade,
      job.exercicio,
    );
  }
}

/**
 * Tipos públicos da engine de relatórios.
 *
 * A engine mora no pacote (fila, orquestração, worker PDF, formatos de saída);
 * o APP fornece os pontos de acoplamento via {@link ReportEngineOptions}:
 * fonte de dados (services/DAOs), pasta de views, contexto, notificações e
 * persistência auxiliar (background_jobs etc.) por hooks.
 */

export interface ReportUser {
  id: string;
  username: string;
  /** Código da entidade (tenant). */
  entidade: number | string;
  [extra: string]: unknown;
}

/**
 * Definição do relatório carregada PELO APP (tabela `reports`) e passada no
 * enqueue. A engine nunca lê o banco do app.
 */
export interface ReportDefinition {
  id: string;
  title: string;
  /** Sub-tag do relatório dentro da fonte de dados (ex.: "2-3"). */
  tag: string;
  /** Tag que o resolver do app usa para achar o service/DAO. */
  model_tag: string | number;
  /** Caminho da view relativo ao viewsRoot (após resolveView). */
  view_path: string;
  [extra: string]: unknown;
}

export interface EnqueueReportRequest {
  /** Default: crypto.randomUUID(). */
  id?: string;
  definition: ReportDefinition;
  filters: Record<string, unknown>;
  exercicio: number;
  /** "pdf" (default), "json", ou formato custom registrado. */
  format?: string;
  user: ReportUser;
  /** Passthrough livre (sync com background_jobs, alias…). */
  meta?: Record<string, unknown>;
}

/** Payload persistido na fila SQLite — plano e serializável. */
export interface ReportJobPayload {
  id: string;
  definition: ReportDefinition;
  filters: Record<string, unknown>;
  exercicio: number;
  format: string;
  user: ReportUser;
  meta?: Record<string, unknown>;
}

/** Contrato de status da fila de relatórios. */
export type ReportQueueStatus = "enqueued" | "processing" | "completed" | "error";

/** Visão externa de um job (status/fila). */
export interface ReportQueueView {
  id: string;
  title: string;
  status: ReportQueueStatus;
  format: string;
  user: ReportUser;
  definition: ReportDefinition;
  filters: Record<string, unknown>;
  exercicio: number;
  meta?: Record<string, unknown>;
  createdAt: number;
  error?: string;
  position?: number;
  queueSize?: number;
}

export interface ReportProgress {
  phase: "generating" | "merging";
  current: number;
  total: number;
  percent: number;
  message: string;
  /** Dados extras do renderer (ex.: paginasGeradas/totalEstimado no PDF). */
  meta?: Record<string, unknown>;
}

export interface ReportResult {
  /** Nome do arquivo dentro do outputDir (ex.: "<jobId>.pdf"). */
  file: string;
  contentType: string;
  parts: number;
  bytes: number;
  durationMs: number;
}

export interface ReportHeader {
  brasaoURL?: string;
  brasaoBase64?: string;
  [extra: string]: unknown;
}

export interface ReportAssinatura {
  name: string;
  role: string;
}

// ── Fonte de dados (dispatch para o app) ─────────────────────────────────────

/**
 * Superfície mínima que services e DAOs expõem para o relatório.
 * O DataSource é dono da própria sessão de banco (tx/RLS).
 */
export interface ReportDataSource {
  report(
    filters: any,
    reportTag: string,
    entidade: number | string,
    exercicio: number,
  ): Promise<unknown>;
  posProcessReportData?(
    data: unknown,
    filters: any,
    reportTag: string,
    entidade: number | string,
    exercicio: number,
  ): Promise<unknown>;
}

export type ReportDataSourceResolver = (
  modelTag: string | number,
  job: ReportJobPayload,
) => ReportDataSource | Promise<ReportDataSource>;

// ── Strategy de formato de saída ─────────────────────────────────────────────

export interface ReportOutputContext {
  job: ReportJobPayload;
  /** Saída de report() + posProcessReportData. */
  data: unknown;
  /** Absolutos. */
  viewsRoot: string;
  viewDir: string;
  outputDir: string;
  partialsDir: string;
  header?: ReportHeader;
  assinaturas: ReportAssinatura[];
  /** Conteúdo HBS do template ativo (TemplateStore), quando houver. */
  templateSource?: string;
  /** Módulo absoluto com registerReportHelpers(hbs) — helpers custom do app. */
  viewSetupModule?: string;
  onProgress: (progress: ReportProgress) => void;
}

export interface ReportOutputStrategy {
  readonly format: string;
  readonly contentType: string;
  readonly fileExtension: string;
  generate(ctx: ReportOutputContext): Promise<ReportResult>;
}

// ── Contratos dos módulos de view ────────────────────────────────────────────

/** Contrato do main.ts — transformação pura, OBRIGATÓRIA em toda view. */
export interface ReportMainModule {
  buildReportData(options: {
    rows: unknown;
    filters: any;
    title: string;
    exercicio: number;
    orderByFunction?: (a: any, b: any) => number;
  }): unknown | Promise<unknown>;
}

/** Contrato do render.ts — HTML para o formato PDF (contrato congelado). */
export interface ReportRenderModule {
  buildReportHTML(options: {
    rows: unknown;
    header?: ReportHeader;
    title: string;
    filters: any;
    jobId: string;
    orderByFunction?: (a: any, b: any) => number;
    assinaturas: ReportAssinatura[];
    templateSource?: string;
    /** Opção B: total geral pré-calculado pelo engine (via computeTotals) sobre TODAS as linhas. */
    totals?: unknown;
    /** Opção B: true na última parte do lote (ou em passada única) — a view mostra o total só aqui. */
    isLastBatch?: boolean;
  }): Promise<{ html: string; disableHeaderFooter?: boolean }>;
  SUPPORTS_BATCHING?: boolean;
  BATCH_MAX_WEIGHT?: number;
  getBatchWeight?(row: unknown): number;
  EXTERNALIZE_HEADER_IMAGE?: boolean;
  /**
   * Opção B — total geral batch-safe. Agregação PURA sobre TODAS as linhas (sem HTML), usada
   * pelo engine para calcular o total uma vez e injetar em cada parte via `totals`. Só necessária
   * em relatórios com TOTAL GERAL entre linhas que queiram batear.
   */
  computeTotals?(rows: readonly unknown[]): unknown;
}

// ── Notificações ─────────────────────────────────────────────────────────────

export interface ReportNotifier {
  /** Mudança de status (persistível no painel — armazena:true no legado). */
  notifyStatus(item: ReportQueueView): void;
  /** Progresso granular efêmero (armazena:false no legado). */
  notifyProgress(job: ReportJobPayload, progress: ReportProgress): void;
}

// ── Templates (Studio) ───────────────────────────────────────────────────────

export interface ReportTemplate {
  id: string;
  reportId: string;
  name: string;
  content: string;
  active: boolean;
  createdAt: number;
}

export interface ReportTemplateStore {
  save(
    reportId: string,
    template: { name: string; content: string },
  ): ReportTemplate | Promise<ReportTemplate>;
  list(reportId: string): ReportTemplate[] | Promise<ReportTemplate[]>;
  get(id: string): ReportTemplate | null | Promise<ReportTemplate | null>;
  setActive(reportId: string, templateId: string | null): void | Promise<void>;
  getActive(reportId: string): ReportTemplate | null | Promise<ReportTemplate | null>;
}

// ── Configuração ─────────────────────────────────────────────────────────────

export interface ReportEngineHooks {
  /** Ex.: criar background_jobs/pending_reports no banco do app. */
  onEnqueued?: (job: ReportJobPayload) => void | Promise<void>;
  onStarted?(job: ReportJobPayload): void | Promise<void>;
  onCompleted?(job: ReportJobPayload, result: ReportResult): void | Promise<void>;
  onFailed?(job: ReportJobPayload, error: string): void | Promise<void>;
}

export interface ReportEngineOptions {
  /** Raiz ABSOLUTA das views de relatório do app. */
  viewsRoot: string;
  /** Resolve a fonte de dados pela model_tag (service/DAO do app). */
  resolveDataSource: ReportDataSourceResolver;

  /** Default: join(process.cwd(), "report"). */
  outputDir?: string;
  /** Default: join(process.cwd(), "data", "report_queue.db"). */
  queueDbPath?: string;
  /** Default: "reports". */
  queueName?: string;
  /** Default: "report_jobs". */
  queueTable?: string;
  /** Default: max(1, env REPORT_CONCURRENCY || 1). */
  concurrency?: number;
  /** Default: 1000. */
  pollMs?: number;
  /** Retenção de jobs terminados. Default: 24h. */
  retentionMs?: number;

  /** Reidrata o contexto do app (ALS store.run). Default: fn(). */
  runInContext?: <T>(job: ReportJobPayload, fn: () => Promise<T>) => Promise<T>;
  notifier?: ReportNotifier;
  /** Cabeçalho/brasão (ex.: configuracoes do app). */
  provideHeader?: (job: ReportJobPayload) => Promise<ReportHeader | undefined>;
  /** Assinaturas (ex.: relatorio_assinatura do app). */
  provideAssinaturas?: (job: ReportJobPayload) => Promise<ReportAssinatura[]>;
  /**
   * Normaliza/resolve o caminho da view. Recebe o job completo para o app poder
   * variar por CNPJ/config da entidade. Default: identidade.
   */
  resolveView?: (viewPath: string, job: ReportJobPayload) => string;
  /** Default: SqliteTemplateStore no mesmo SQLite da engine. */
  templateStore?: ReportTemplateStore;
  /** Default: join(viewsRoot, "partials"). */
  partialsDir?: string;
  /** Módulo ABSOLUTO exportando registerReportHelpers(hbs). */
  viewSetupModule?: string;
  /** Strategies extras/override (registradas por cima de pdf+json). */
  formats?: ReportOutputStrategy[];
  hooks?: ReportEngineHooks;
  /** Sobe o worker (Chromium) no boot. Default: true. false p/ CI/JSON-only. */
  warmupWorker?: boolean;
  /** Override do arquivo do worker (escape hatch node_modules). */
  workerFile?: string | URL;
  /** Status HTTP do forge. Default: 203. */
  enqueueStatusCode?: number;
}

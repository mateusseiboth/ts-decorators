import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import path from "path";

import { convertBigIntValues } from "../functions/sql";
import type { QueueJob } from "../queue/adapter";
import { registerProcessor, registerQueue, startProcessors } from "../queue/registry";
import { SqliteQueueAdapter } from "../queue/SqliteQueueAdapter";
import { JsonOutputStrategy } from "./formats/JsonOutputStrategy";
import { ReportFormatRegistry } from "./formats/OutputStrategy";
import { PdfOutputStrategy } from "./formats/PdfOutputStrategy";
import { NullReportNotifier } from "./notifier";
import { ReportProcessor } from "./ReportProcessor";
import { SqliteTemplateStore } from "./templates/SqliteTemplateStore";
import type {
  EnqueueReportRequest,
  ReportEngineOptions,
  ReportJobPayload,
  ReportNotifier,
  ReportQueueStatus,
  ReportQueueView,
  ReportTemplateStore,
} from "./types";
import { ReportWorkerManager, type ReportWorkerStatus } from "./worker/ReportWorkerManager";

const STATUS_LEGADO: Record<QueueJob["status"], ReportQueueStatus> = {
  pending: "enqueued",
  processing: "processing",
  completed: "completed",
  failed: "error",
};

const UM_DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Fachada da engine de relatórios — fila durável em SQLite PRÓPRIO (nunca exige
 * migration no banco do app) sobre o registry genérico de filas do pacote
 * (registerQueue/registerProcessor/startProcessors — a mesma engine dos jobs
 * @Queue/@Processor). O job é criado com o PRÓPRIO id do relatório, então
 * status/download funcionam pelo mesmo identificador.
 */
export class ReportEngine {
  readonly outputDir: string;
  readonly enqueueStatusCode: number;
  readonly templateStore: ReportTemplateStore;
  readonly formats: ReportFormatRegistry;

  private readonly adapter: SqliteQueueAdapter<ReportJobPayload>;
  private readonly notifier: ReportNotifier;
  private readonly processor: ReportProcessor;
  private readonly hooks: NonNullable<ReportEngineOptions["hooks"]>;
  private readonly concurrency: number;
  private readonly retentionMs: number;
  private workerManager?: ReportWorkerManager;
  private readonly queueName: string;
  private readonly workerFile?: string | URL;

  constructor(private readonly options: ReportEngineOptions) {
    const queueDbPath = options.queueDbPath ?? path.join(process.cwd(), "data", "report_queue.db");
    this.outputDir = options.outputDir ?? path.join(process.cwd(), "report");
    this.enqueueStatusCode = options.enqueueStatusCode ?? 203;
    this.concurrency = Math.max(
      1,
      options.concurrency ?? (Number(process.env.REPORT_CONCURRENCY) || 1),
    );
    this.retentionMs = options.retentionMs ?? UM_DIA_MS;
    this.hooks = options.hooks ?? {};
    this.notifier = options.notifier ?? new NullReportNotifier();
    this.workerFile = options.workerFile;

    for (const dir of [path.dirname(queueDbPath), this.outputDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    this.adapter = new SqliteQueueAdapter<ReportJobPayload>(
      queueDbPath,
      options.queueTable ?? "report_jobs",
    );
    this.limparAntigosEResetarOrfaos();

    this.templateStore = options.templateStore ?? new SqliteTemplateStore(queueDbPath);

    this.formats = new ReportFormatRegistry();
    this.formats.register(new PdfOutputStrategy(() => this.getWorkerManager()));
    this.formats.register(new JsonOutputStrategy());
    for (const strategy of options.formats ?? []) this.formats.register(strategy);

    this.processor = new ReportProcessor({
      viewsRoot: options.viewsRoot,
      outputDir: this.outputDir,
      partialsDir: options.partialsDir ?? path.join(options.viewsRoot, "partials"),
      viewSetupModule: options.viewSetupModule,
      resolveDataSource: options.resolveDataSource,
      runInContext: options.runInContext ?? ((_job, fn) => fn()),
      provideHeader: options.provideHeader,
      provideAssinaturas: options.provideAssinaturas,
      resolveView: options.resolveView ?? ((viewPath) => viewPath),
      templateStore: this.templateStore,
      formats: this.formats,
    });

    this.queueName = options.queueName ?? "reports";
    const queueName = this.queueName;
    registerQueue(queueName, this.adapter);
    registerProcessor(queueName, {
      handler: (payload: ReportJobPayload) => this.processar(payload),
      concurrency: this.concurrency,
      pollMs: options.pollMs ?? 1000,
    });
    startProcessors();

    if (options.warmupWorker !== false) this.getWorkerManager();
  }

  /** Worker (Chromium) sob demanda — warmupWorker:false não sobe Chrome à toa. */
  private getWorkerManager(): ReportWorkerManager {
    if (!this.workerManager) {
      this.workerManager = new ReportWorkerManager({
        concurrency: this.concurrency,
        workerFile: this.workerFile,
      });
    }
    return this.workerManager;
  }

  /** Limpa concluídos/erros antigos e devolve órfãos "processing" à fila. */
  private limparAntigosEResetarOrfaos(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const status of ["completed", "failed"] as const) {
      for (const job of this.adapter.findMany({ status })) {
        if (job.createdAt < cutoff) this.adapter.delete(job.id);
      }
    }
    for (const job of this.adapter.findMany({ status: "processing" })) {
      this.adapter.update(job.id, { status: "pending" });
    }
  }

  // ── API pública ──────────────────────────────────────────────────────────────

  async enqueue(request: EnqueueReportRequest): Promise<ReportQueueView> {
    const format = request.format ?? "pdf";
    // Falha AGORA (403/500 no forge) se o formato não existe — não na fila.
    this.formats.get(format);

    // A definição vem crua do Prisma (sequencial BigInt etc.) e o payload é
    // serializado para o SQLite — converte BigInt ANTES de persistir/responder.
    const payload = convertBigIntValues({
      id: request.id ?? randomUUID(),
      definition: request.definition,
      filters: request.filters ?? {},
      exercicio: request.exercicio,
      format,
      user: request.user,
      meta: request.meta,
    }) as ReportJobPayload;

    await this.hooks.onEnqueued?.(payload);

    const job = this.adapter.create({
      id: payload.id,
      payload,
      status: "pending",
      createdAt: Date.now(),
    });

    const view = this.toQueueView(job);
    this.notifier.notifyStatus(view);
    return view;
  }

  getStatus(id: string): ReportQueueView | null {
    const job = this.adapter.findUnique(id);
    return job ? this.toQueueView(job) : null;
  }

  getUserJobs(userId: string, entidade: number | string): ReportQueueView[] {
    return this.adapter
      .findMany()
      .filter(
        (job) =>
          job.payload.user.id === userId && String(job.payload.user.entidade) === String(entidade),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((job) => this.toQueueView(job));
  }

  /** Arquivo gerado (path/contentType pelo formato do job). null se não existe. */
  getResultFile(id: string): { path: string; contentType: string; filename: string } | null {
    const job = this.adapter.findUnique(id);
    if (!job) return null;
    const strategy = this.formats.get(job.payload.format);
    const filePath = path.join(this.outputDir, `${id}.${strategy.fileExtension}`);
    if (!existsSync(filePath)) return null;
    return {
      path: filePath,
      contentType: strategy.contentType,
      filename: `relatorio-${id}.${strategy.fileExtension}`,
    };
  }

  /** Dados TRATADOS da view sem enfileirar — rota síncrona /data (Studio). */
  async buildViewModel(request: EnqueueReportRequest): Promise<unknown> {
    return this.processor.buildViewModel({
      id: request.id ?? randomUUID(),
      definition: request.definition,
      filters: request.filters ?? {},
      exercicio: request.exercicio,
      format: "json",
      user: request.user,
      meta: request.meta,
    });
  }

  /**
   * Estado da engine para health check: a fila onde os relatórios esperam e o worker (Chrome).
   * `worker` nulo quer dizer que ele ainda não subiu (`warmupWorker: false` e nenhum PDF pedido).
   */
  health(): { queue: string; worker: ReportWorkerStatus | null } {
    return { queue: this.queueName, worker: this.workerManager?.status() ?? null };
  }

  /** Encerra worker (Chrome) e fecha o SQLite — para o drain do app. */
  async shutdown(): Promise<void> {
    await this.workerManager?.shutdown();
    this.adapter.close();
  }

  // ── Processamento (handler da fila genérica) ────────────────────────────────

  private async processar(payload: ReportJobPayload): Promise<void> {
    const processing = this.getStatus(payload.id);
    if (processing) this.notifier.notifyStatus({ ...processing, status: "processing" });
    await this.safeHook(() => this.hooks.onStarted?.(payload));

    try {
      const result = await this.processor.process(payload, (progress) =>
        this.notifier.notifyProgress(payload, progress),
      );
      this.finalizar(payload.id, true);
      await this.safeHook(() => this.hooks.onCompleted?.(payload, result));
    } catch (error: any) {
      const message = error?.message ?? String(error);
      this.finalizar(payload.id, false, message);
      await this.safeHook(() => this.hooks.onFailed?.(payload, message));
      // Re-lança para o registry marcar o job como failed.
      throw error;
    }
  }

  /** Hooks do app nunca derrubam o pipeline de notificação/estado. */
  private async safeHook(run: () => void | Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      console.error("[REPORT] Erro em hook do app:", err);
    }
  }

  /** Marca o desfecho no adapter e publica as notificações finais. */
  private finalizar(jobId: string, success: boolean, error?: string): void {
    // O registry também atualiza o status ao término do handler; atualizamos aqui
    // primeiro para que as notificações (posições recalculadas) leiam o estado final.
    this.adapter.update(jobId, {
      status: success ? "completed" : "failed",
      error: success ? undefined : error,
    });

    const item = this.getStatus(jobId);
    if (item) this.notifier.notifyStatus(item);
    this.notifyQueuePositions();
  }

  // ── Conversões / posições ────────────────────────────────────────────────────

  private toQueueView(job: QueueJob<ReportJobPayload>): ReportQueueView {
    const view: ReportQueueView = {
      id: job.payload.id,
      title: job.payload.definition.title,
      status: STATUS_LEGADO[job.status],
      format: job.payload.format,
      user: job.payload.user,
      definition: job.payload.definition,
      filters: job.payload.filters,
      exercicio: job.payload.exercicio,
      meta: job.payload.meta,
      createdAt: job.createdAt,
      error: job.error,
    };

    if (view.status === "enqueued") {
      const posicao = this.getQueuePosition(job);
      view.position = posicao.position;
      view.queueSize = posicao.queueSize;
    }

    return view;
  }

  private getQueuePosition(job: QueueJob<ReportJobPayload>): {
    position: number;
    queueSize: number;
  } {
    const pendentes = this.adapter.findMany({ status: "pending" });
    const processando = this.adapter.findMany({ status: "processing" });
    const aFrente = pendentes.filter((p) => p.createdAt < job.createdAt).length;
    return {
      position: aFrente + 1,
      queueSize: pendentes.length + processando.length,
    };
  }

  private notifyQueuePositions(): void {
    const pendentes = this.adapter
      .findMany({ status: "pending" })
      .sort((a, b) => a.createdAt - b.createdAt);
    const processando = this.adapter.findMany({ status: "processing" }).length;

    pendentes.forEach((job, index) => {
      const view = this.toQueueView(job);
      view.position = index + 1;
      view.queueSize = pendentes.length + processando;
      this.notifier.notifyStatus(view);
    });
  }
}

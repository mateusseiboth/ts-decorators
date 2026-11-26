import { Worker } from "worker_threads";

import { Semaphore } from "../../concurrency/Semaphore";
import type { ReportPageFormat, ReportProgress } from "../types";
import type { ReportPdfAttachmentPlan } from "./pdfAttachments";

/** Payload plano enviado ao pdf.worker (caminhos ABSOLUTOS, sem funções). */
export interface ReportWorkerPayload {
  jobId: string;
  data: any;
  title: string;
  header: any;
  assinaturas: any[];
  filters?: any;
  renderModulePath: string;
  partialsDir: string;
  outputDir: string;
  templateSource?: string;
  viewSetupModule?: string;
  pageFormat?: ReportPageFormat;
  preferCSSPageSize?: boolean;
  /**
   * Streaming de dados: quando presente, o main já fatiou as linhas em arquivos de página
   * (`<jobId>.page<N>.json`) no disco e NÃO enviou `data` (evita o postMessage de GBs). O worker
   * lê UMA página por vez → memória constante, independente do tamanho do relatório.
   */
  pageFiles?: string[];
  /** Total geral pré-calculado pelo main (computeTotals) — injetado na última parte (Opção B). */
  totals?: any;
  /** Em streaming: onde entra cada PDF anexado (`getPdfAttachments` da view), já planejado no main. */
  attachmentPlan?: ReportPdfAttachmentPlan;
}

interface PendingJob {
  resolve: (result: { parts: number; bytes: number }) => void;
  reject: (err: Error) => void;
  startedAt: number;
  onProgress?: (progress: ReportProgress) => void;
  /** Cinto de seguranca: sem ele, worker que nao responde deixa o job pendurado para sempre. */
  timer: ReturnType<typeof setTimeout>;
}

/** Estado do worker para health check: só flags, contadores e instantes (ISO). */
export interface ReportWorkerStatus {
  alive: boolean;
  shuttingDown: boolean;
  inFlight: number;
  concurrency: number;
  restarts: number;
  completed: number;
  failed: number;
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
}

/** Teto de espera por job. Relatorio grande leva minutos; pendurar para sempre nao e opcao. */
const JOB_TIMEOUT_PADRAO_MS = 30 * 60_000;

/**
 * ReportWorkerManager — mantém UM worker de relatório SEMPRE vivo (Chrome quente),
 * em vez de criar/matar um Worker por relatório.
 *
 * - O worker é o `pdf.worker.ts` do PRÓPRIO pacote (resolvido por import.meta.url;
 *   substituível via `workerFile` na config — escape hatch para ambientes onde o
 *   worker não roda de dentro de node_modules).
 * - Cada job é correlacionado por `jobId`; mensagens do worker resolvem a promise
 *   correspondente (vários jobs podem estar em voo).
 * - Semáforo de instância limita as gerações simultâneas (concurrency da engine).
 * - Reinicia automaticamente em caso de erro/saída; `shutdown()` encerra no drain.
 */
export class ReportWorkerManager {
  private worker?: Worker;
  private shuttingDown = false;
  private readonly pending = new Map<string, PendingJob>();
  private readonly workerPath: string | URL;
  private readonly semaphore: Semaphore;
  private readonly jobTimeoutMs: number;
  private readonly concurrency: number;
  private restarts = 0;
  private completed = 0;
  private failed = 0;
  private lastCompletedAt: Date | null = null;
  private lastFailedAt: Date | null = null;

  constructor(options: {
    concurrency: number;
    workerFile?: string | URL;
    warmup?: boolean;
    jobTimeoutMs?: number;
  }) {
    this.workerPath = options.workerFile ?? new URL("./pdf.worker.ts", import.meta.url);
    this.concurrency = Math.max(1, options.concurrency);
    this.semaphore = new Semaphore(this.concurrency);
    this.jobTimeoutMs = options.jobTimeoutMs ?? JOB_TIMEOUT_PADRAO_MS;
    if (options.warmup !== false) this.ensureWorker();
  }

  private ensureWorker(): void {
    if (this.worker || this.shuttingDown) return;
    this.spawnWorker();
  }

  private spawnWorker(): void {
    console.log(`[ReportWorker] 🚀 Iniciando worker persistente (${String(this.workerPath)})`);
    const worker = new Worker(this.workerPath);

    worker.on("message", (msg: any) => this.handleWorkerMessage(msg));

    worker.on("error", (err) => {
      console.error("[ReportWorker] ❌ Erro no worker:", err);
      this.failAllPending(err instanceof Error ? err : new Error(String(err)));
      this.scheduleRespawn();
    });

    worker.on("exit", (code) => {
      if (this.shuttingDown) return;
      console.warn(`[ReportWorker] ⚠️  Worker encerrou (code=${code}). Reiniciando...`);
      this.failAllPending(new Error(`Worker finalizado com código ${code}`));
      this.scheduleRespawn();
    });

    this.worker = worker;
    // A thread ainda vai carregar o modulo. Quem confirma que esta de pe e o proprio
    // worker, com o log "[REPORT:WORKER] 🟢 Worker persistente iniciado".
    console.log("[ReportWorker] ⏳ Thread do worker criada, aguardando o modulo carregar.");
  }

  private scheduleRespawn(): void {
    this.worker = undefined;
    if (this.shuttingDown) return; // em shutdown de deploy não reinicia o worker.
    this.restarts++;
    setTimeout(() => {
      if (!this.worker && !this.shuttingDown) this.spawnWorker();
    }, 1000);
  }

  /** Estado atual, para health check. */
  status(): ReportWorkerStatus {
    return {
      alive: !!this.worker && !this.shuttingDown,
      shuttingDown: this.shuttingDown,
      inFlight: this.pending.size,
      concurrency: this.concurrency,
      restarts: this.restarts,
      completed: this.completed,
      failed: this.failed,
      lastCompletedAt: this.lastCompletedAt?.toISOString() ?? null,
      lastFailedAt: this.lastFailedAt?.toISOString() ?? null,
    };
  }

  /** Encerra o worker (e o Chrome quente dentro dele) no shutdown gracioso. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
    console.log("[ReportWorker] 🧹 Worker de relatório encerrado (Chrome fechado).");
  }

  private failAllPending(err: Error): void {
    for (const [, job] of this.pending) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    this.pending.clear();
  }

  private handleWorkerMessage(msg: any): void {
    const jobId: string | undefined = msg?.jobId;
    if (!jobId) {
      // Erro sem jobId e falha de PROTOCOLO: o payload nem parseou no worker, entao
      // ninguem sabe de quem e. Antes isto so logava e retornava — e o job ficava
      // pendurado para sempre. Falhar os pendentes e honesto; calar nao.
      const erro = msg?.error ? String(msg.error) : null;
      if (erro) {
        console.error(`[ReportWorker] ❌ Erro de protocolo (sem jobId): ${erro}`);
        this.failAllPending(new Error(erro));
        return;
      }
      console.warn("[ReportWorker] Mensagem sem jobId recebida:", msg);
      return;
    }
    const job = this.pending.get(jobId);
    if (!job) {
      console.warn(`[ReportWorker] Job desconhecido na resposta: ${jobId}`);
      return;
    }

    // Mensagem de progresso (não-terminal): repassa e mantém o job pendente.
    if (msg.progress && !msg.error && !msg.success) {
      try {
        job.onProgress?.(msg.progress as ReportProgress);
      } catch (err) {
        console.error(`[ReportWorker] Erro no onProgress do job ${jobId}:`, err);
      }
      return;
    }

    this.pending.delete(jobId);
    clearTimeout(job.timer);
    const elapsed = Date.now() - job.startedAt;

    if (msg.error) {
      this.failed++;
      this.lastFailedAt = new Date();
      console.error(`[ReportWorker] ❌ Job ${jobId} falhou após ${elapsed}ms: ${msg.error}`);
      job.reject(new Error(msg.error));
      return;
    }
    this.completed++;
    this.lastCompletedAt = new Date();
    console.log(`[ReportWorker] ✅ Job ${jobId} concluído em ${elapsed}ms`);
    job.resolve({ parts: msg.result?.parts ?? 1, bytes: msg.result?.bytes ?? 0 });
  }

  /**
   * Despacha um relatório para o worker persistente (limitado pelo semáforo).
   * Resolve quando o worker confirma o término e rejeita em erro.
   */
  async generate(
    options: ReportWorkerPayload,
    onProgress?: (progress: ReportProgress) => void,
  ): Promise<{ parts: number; bytes: number }> {
    return this.semaphore.runExclusive(() => this.dispatch(options, onProgress));
  }

  private async dispatch(
    options: ReportWorkerPayload,
    onProgress?: (progress: ReportProgress) => void,
  ): Promise<{ parts: number; bytes: number }> {
    this.ensureWorker();
    if (!this.worker) {
      // Worker reiniciando — aguarda um instante e tenta novamente uma vez.
      await new Promise((r) => setTimeout(r, 1500));
      this.ensureWorker();
      if (!this.worker) throw new Error("Worker de relatório indisponível.");
    }

    const jobId = options.jobId;
    console.log(
      `[ReportWorker] ▶️  Recebido job ${jobId} ("${options.title}"). Em processamento: ${this.pending.size + 1}`,
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(jobId)) return;
        this.failed++;
        this.lastFailedAt = new Date();
        console.error(
          `[ReportWorker] ⏰ Job ${jobId} nao respondeu em ${this.jobTimeoutMs}ms — abortado.`,
        );
        reject(
          new Error(`Worker de relatorio nao respondeu em ${this.jobTimeoutMs}ms (job ${jobId}).`),
        );
      }, this.jobTimeoutMs);

      this.pending.set(jobId, { resolve, reject, startedAt: Date.now(), onProgress, timer });
      try {
        const buffer = Buffer.from(JSON.stringify(options), "utf-8");
        // O worker passa a ser o dono dos dados. Limpa a referência do chamador assim
        // que a cópia serializada foi transferida, em vez de mantê-la até o PDF terminar.
        options.data = undefined;
        this.worker!.postMessage(buffer, [buffer.buffer]);
      } catch (error) {
        options.data = undefined;
        this.pending.delete(jobId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

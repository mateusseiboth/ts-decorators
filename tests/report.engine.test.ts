import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { clearQueues } from "../src/queue/registry";
import { SqliteQueueAdapter } from "../src/queue/SqliteQueueAdapter";
import { configureReportEngine, resetReportEngine } from "../src/report/config";
import type {
  ReportDefinition,
  ReportNotifier,
  ReportOutputContext,
  ReportOutputStrategy,
  ReportResult,
} from "../src/report/types";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VIEWS_ROOT = path.join(import.meta.dir, "fixtures", "views");

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "bc-report-"));
}

function definition(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
  return {
    id: "def-1",
    title: "Relatório Demo",
    tag: "1",
    model_tag: "26",
    view_path: "demo",
    ...overrides,
  };
}

const user = { id: "u1", username: "MATEUS", entidade: 4 };

class FakeStrategy implements ReportOutputStrategy {
  readonly format = "fake";
  readonly contentType = "text/plain";
  readonly fileExtension = "txt";
  readonly contexts: ReportOutputContext[] = [];
  readonly progressSteps = 3;

  async generate(ctx: ReportOutputContext): Promise<ReportResult> {
    this.contexts.push({ ...ctx });
    for (let i = 1; i <= this.progressSteps; i++) {
      ctx.onProgress({
        phase: "generating",
        current: i,
        total: this.progressSteps,
        percent: Math.round((i / this.progressSteps) * 100),
        message: `passo ${i}`,
      });
    }
    const file = `${ctx.job.id}.txt`;
    writeFileSync(path.join(ctx.outputDir, file), "ok");
    return { file, contentType: this.contentType, parts: 1, bytes: 2, durationMs: 1 };
  }
}

class RecordingNotifier implements ReportNotifier {
  statuses: Array<{ id: string; status: string; position?: number; queueSize?: number }> = [];
  progresses: Array<{ id: string; percent: number }> = [];

  notifyStatus(item: any): void {
    this.statuses.push({
      id: item.id,
      status: item.status,
      position: item.position,
      queueSize: item.queueSize,
    });
  }
  notifyProgress(job: any, progress: any): void {
    this.progresses.push({ id: job.id, percent: progress.percent });
  }
}

let queueSeq = 0;
function baseOptions(dir: string, extra: Record<string, any> = {}) {
  return {
    viewsRoot: VIEWS_ROOT,
    outputDir: path.join(dir, "report"),
    queueDbPath: path.join(dir, "queue.db"),
    queueName: `reports-test-${++queueSeq}`,
    pollMs: 10,
    warmupWorker: false,
    resolveDataSource: () => ({
      report: async () => [
        { nome: "Item A", valor: 10 },
        { nome: "Item B", valor: 5.5 },
      ],
    }),
    ...extra,
  };
}

afterEach(async () => {
  await resetReportEngine();
  clearQueues();
});

describe("ReportEngine (fila SQLite própria + strategy de formato)", () => {
  test("ciclo completo: enqueued → processing → completed, hooks na ordem, notifier com posição", async () => {
    const dir = tempDir();
    const fake = new FakeStrategy();
    const notifier = new RecordingNotifier();
    const hookCalls: string[] = [];

    const engine = configureReportEngine(
      baseOptions(dir, {
        formats: [fake],
        notifier,
        hooks: {
          onEnqueued: () => void hookCalls.push("enqueued"),
          onStarted: () => void hookCalls.push("started"),
          onCompleted: (_job: any, result: ReportResult) =>
            void hookCalls.push(`completed:${result.file}`),
          onFailed: () => void hookCalls.push("failed"),
        },
      }),
    );

    const view = await engine.enqueue({
      definition: definition(),
      filters: { ano: 2026 },
      exercicio: 2026,
      format: "fake",
      user,
    });

    expect(view.status).toBe("enqueued");
    expect(view.position).toBe(1);
    expect(view.queueSize).toBe(1);

    await delay(150);

    const done = engine.getStatus(view.id);
    expect(done?.status).toBe("completed");
    expect(hookCalls).toEqual(["enqueued", "started", `completed:${view.id}.txt`]);

    // Strategy recebeu dados da fonte + contexto com paths absolutos.
    expect(fake.contexts.length).toBe(1);
    expect(fake.contexts[0].viewDir).toBe(path.join(VIEWS_ROOT, "demo"));
    expect((fake.contexts[0].data as any[]).length).toBe(2);

    // Notifier: enqueued (posição), processing, completed + progressos.
    const statuses = notifier.statuses.map((s) => s.status);
    expect(statuses).toContain("enqueued");
    expect(statuses).toContain("processing");
    expect(statuses).toContain("completed");
    expect(notifier.progresses.map((p) => p.percent)).toEqual([33, 67, 100]);

    // Download resolvido pelo formato do job.
    const file = engine.getResultFile(view.id);
    expect(file?.contentType).toBe("text/plain");
    expect(file?.filename).toBe(`relatorio-${view.id}.txt`);
  });

  test("falha na fonte de dados → status error + hook onFailed", async () => {
    const dir = tempDir();
    const notifier = new RecordingNotifier();
    const failures: string[] = [];

    const engine = configureReportEngine(
      baseOptions(dir, {
        formats: [new FakeStrategy()],
        notifier,
        resolveDataSource: () => ({
          report: async () => {
            throw new Error("query explodiu");
          },
        }),
        hooks: { onFailed: (_job: any, error: string) => void failures.push(error) },
      }),
    );

    const view = await engine.enqueue({
      definition: definition(),
      filters: {},
      exercicio: 2026,
      format: "fake",
      user,
    });

    await delay(150);

    expect(engine.getStatus(view.id)?.status).toBe("error");
    expect(engine.getStatus(view.id)?.error).toBe("query explodiu");
    expect(failures).toEqual(["query explodiu"]);
  });

  test("formato desconhecido falha NO ENQUEUE (não na fila)", async () => {
    const dir = tempDir();
    const engine = configureReportEngine(baseOptions(dir));

    await expect(
      engine.enqueue({
        definition: definition(),
        filters: {},
        exercicio: 2026,
        format: "xml",
        user,
      }),
    ).rejects.toThrow(/Formato de relatório desconhecido/);
  });

  test("boot reseta órfãos 'processing' (reprocessa) e apaga terminados antigos", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "queue.db");
    const table = "report_jobs";

    // Simula estado deixado por um crash: 1 órfão em processing + 1 completed velho.
    const seed = new SqliteQueueAdapter(dbPath, table);
    const payload = {
      id: "orfao-1",
      definition: definition(),
      filters: {},
      exercicio: 2026,
      format: "fake",
      user,
    };
    seed.create({ id: "orfao-1", payload, status: "processing", createdAt: Date.now() } as any);
    seed.create({
      id: "velho-1",
      payload: { ...payload, id: "velho-1" },
      status: "completed",
      createdAt: Date.now() - 48 * 60 * 60 * 1000,
    } as any);
    seed.close();

    const fake = new FakeStrategy();
    const engine = configureReportEngine(
      baseOptions(dir, { formats: [fake], queueDbPath: dbPath }),
    );

    await delay(150);

    // Órfão voltou para a fila e foi processado; o antigo sumiu pela retenção.
    expect(engine.getStatus("orfao-1")?.status).toBe("completed");
    expect(fake.contexts.some((c) => c.job.id === "orfao-1")).toBe(true);
    expect(engine.getStatus("velho-1")).toBeNull();
  });

  test("a retenção apaga também o arquivo gerado pelo job", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "queue.db");
    const outputDir = path.join(dir, "report");
    mkdirSync(outputDir, { recursive: true });

    const seed = new SqliteQueueAdapter(dbPath, "report_jobs");
    const payload = {
      definition: definition(),
      filters: {},
      exercicio: 2026,
      format: "fake",
      user,
    };
    const agora = Date.now();
    for (const [id, createdAt] of [
      ["velho-2", agora - 48 * 60 * 60 * 1000],
      ["recente-1", agora],
    ] as const) {
      seed.create({ id, payload: { ...payload, id }, status: "completed", createdAt } as any);
      writeFileSync(path.join(outputDir, `${id}.txt`), "ok");
    }
    seed.close();

    configureReportEngine(
      baseOptions(dir, { formats: [new FakeStrategy()], queueDbPath: dbPath, outputDir }),
    );

    expect(existsSync(path.join(outputDir, "velho-2.txt"))).toBe(false);
    expect(existsSync(path.join(outputDir, "recente-1.txt"))).toBe(true);
  });

  test("definição crua do Prisma (BigInt/Date) não quebra a serialização da fila", async () => {
    const dir = tempDir();
    const fake = new FakeStrategy();
    const engine = configureReportEngine(baseOptions(dir, { formats: [fake] }));

    const view = await engine.enqueue({
      definition: definition({ sequencial: BigInt(42), createdAt: new Date("2026-01-01") } as any),
      filters: {},
      exercicio: 2026,
      format: "fake",
      user,
    });

    // Enfileirou, serializou no SQLite e devolveu a view sem explodir no stringify.
    expect((view.definition as any).sequencial).toBe("42");
    await delay(150);
    expect(engine.getStatus(view.id)?.status).toBe("completed");
    expect((fake.contexts[0].job.definition as any).sequencial).toBe("42");
  });

  test("getUserJobs filtra por usuário e entidade", async () => {
    const dir = tempDir();
    const engine = configureReportEngine(baseOptions(dir, { formats: [new FakeStrategy()] }));

    await engine.enqueue({
      definition: definition(),
      filters: {},
      exercicio: 2026,
      format: "fake",
      user,
    });
    await engine.enqueue({
      definition: definition({ id: "def-2", title: "Outro" }),
      filters: {},
      exercicio: 2026,
      format: "fake",
      user: { id: "u2", username: "OUTRA", entidade: 9 },
    });

    expect(engine.getUserJobs("u1", 4).length).toBe(1);
    expect(engine.getUserJobs("u2", 9).length).toBe(1);
    expect(engine.getUserJobs("u1", 9).length).toBe(0);
  });

  describe("tamanho da página (pageFormat e preferCSSPageSize)", () => {
    const readContexto = async (extra: Record<string, unknown>) => {
      const fake = new FakeStrategy();
      const engine = configureReportEngine(baseOptions(tempDir(), { formats: [fake], ...extra }));
      await engine.enqueue({
        definition: definition(),
        filters: {},
        exercicio: 2026,
        format: "fake",
        user,
      });
      await delay(150);
      return fake.contexts[0];
    };

    test("padrão: A4, e o size do @page não manda", async () => {
      const contexto = await readContexto({});
      expect(contexto?.pageFormat).toBe("A4");
      expect(contexto?.preferCSSPageSize).toBe(false);
    });

    test("o que a engine configura chega ao contexto do formato", async () => {
      const contexto = await readContexto({ pageFormat: "Letter", preferCSSPageSize: true });
      expect(contexto?.pageFormat).toBe("Letter");
      expect(contexto?.preferCSSPageSize).toBe(true);
    });
  });
});

describe("ReportEngine com perTenant", () => {
  /** Segura cada relatório por 40 ms e anota a ordem de início e o pico por entidade. */
  class LentaStrategy implements ReportOutputStrategy {
    readonly format = "lenta";
    readonly contentType = "text/plain";
    readonly fileExtension = "txt";
    readonly inicios: string[] = [];
    readonly pico = new Map<string, number>();
    private readonly emVoo = new Map<string, number>();

    async generate(ctx: ReportOutputContext): Promise<ReportResult> {
      const entidade = String(ctx.job.user.entidade);
      const agora = (this.emVoo.get(entidade) ?? 0) + 1;
      this.emVoo.set(entidade, agora);
      this.pico.set(entidade, Math.max(this.pico.get(entidade) ?? 0, agora));
      this.inicios.push(entidade);
      await delay(40);
      this.emVoo.set(entidade, (this.emVoo.get(entidade) ?? 1) - 1);
      const file = `${ctx.job.id}.txt`;
      writeFileSync(path.join(ctx.outputDir, file), "ok");
      return { file, contentType: this.contentType, parts: 1, bytes: 2, durationMs: 1 };
    }
  }

  test("a entidade com vários relatórios não segura a outra", async () => {
    const lenta = new LentaStrategy();
    const engine = configureReportEngine(
      baseOptions(tempDir(), {
        formats: [lenta],
        concurrency: 2,
        perTenant: { concurrency: 1 },
      }),
    );
    const pedir = (entidade: number) =>
      engine.enqueue({
        definition: definition(),
        filters: {},
        exercicio: 2026,
        format: "lenta",
        user: { ...user, entidade },
      });
    const pedidos = [await pedir(4), await pedir(4), await pedir(11)];

    const limite = Date.now() + 5_000;
    while (pedidos.some((pedido) => engine.getStatus(pedido.id)?.status !== "completed")) {
      if (Date.now() > limite) throw new Error("Os relatórios não terminaram a tempo.");
      await delay(10);
    }

    expect(lenta.pico.get("4")).toBe(1);
    expect(lenta.inicios.slice(0, 2).sort()).toEqual(["11", "4"]);
  });
});

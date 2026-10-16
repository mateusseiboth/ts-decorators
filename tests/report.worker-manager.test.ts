import { describe, expect, test } from "bun:test";
import path from "path";

import { ReportWorkerManager } from "../src/report/worker/ReportWorkerManager";
import type { ReportWorkerPayload } from "../src/report/worker/ReportWorkerManager";

const ECHO_WORKER = path.join(import.meta.dir, "fixtures", "echo.worker.ts");
const MUDO_WORKER = path.join(import.meta.dir, "fixtures", "mudo.worker.ts");
const SEM_JOBID_WORKER = path.join(import.meta.dir, "fixtures", "semJobId.worker.ts");

function payload(jobId: string, title: string): ReportWorkerPayload {
  return {
    jobId,
    title,
    data: [{ x: 1 }],
    header: {},
    assinaturas: [],
    renderModulePath: "/tmp/nada/render.ts",
    partialsDir: "/tmp/nada",
    outputDir: "/tmp/nada",
  };
}

describe("ReportWorkerManager (worker stub, sem Playwright)", () => {
  test("correlaciona por jobId: progresso + sucesso com result", async () => {
    const manager = new ReportWorkerManager({ concurrency: 2, workerFile: ECHO_WORKER });
    const progresses: number[] = [];

    const result = await manager.generate(payload("job-a", "OK"), (p) =>
      progresses.push(p.percent),
    );

    expect(result).toEqual({ parts: 2, bytes: 1234 });
    expect(progresses).toEqual([50]);
    await manager.shutdown();
  });

  test("erro do worker rejeita apenas o job correspondente", async () => {
    const manager = new ReportWorkerManager({ concurrency: 2, workerFile: ECHO_WORKER });

    const [ok, falha] = await Promise.allSettled([
      manager.generate(payload("job-ok", "OK")),
      manager.generate(payload("job-bad", "FALHA total")),
    ]);

    expect(ok.status).toBe("fulfilled");
    expect(falha.status).toBe("rejected");
    expect((falha as PromiseRejectedResult).reason.message).toContain("erro simulado");
    await manager.shutdown();
  });

  test("shutdown encerra o worker sem reiniciar", async () => {
    const manager = new ReportWorkerManager({ concurrency: 1, workerFile: ECHO_WORKER });
    await manager.generate(payload("job-b", "OK"));
    await manager.shutdown();
    // Após o shutdown não há worker; um novo generate falha rápido em vez de pendurar.
    await expect(manager.generate(payload("job-c", "OK"))).rejects.toThrow(/indisponível/);
  }, 10_000);

  /**
   * O job so saia de "pendente" com uma mensagem terminal do worker. Worker travado
   * (Chrome pendurado, mensagem que nunca chega) deixava o relatorio em
   * "1 em processamento" para sempre — foi exatamente o que aconteceu em producao.
   */
  test("worker que nunca responde e rejeitado por timeout, nao fica pendurado", async () => {
    const manager = new ReportWorkerManager({
      concurrency: 1,
      workerFile: MUDO_WORKER,
      jobTimeoutMs: 800,
    });

    await expect(manager.generate(payload("job-mudo", "OK"))).rejects.toThrow(/n[aã]o respondeu/i);
    await manager.shutdown();
  }, 10_000);

  /**
   * Erro sem jobId e falha de PROTOCOLO (o payload nem parseou, ninguem sabe de quem e).
   * Antes o manager so logava "Mensagem sem jobId" e retornava — o job ficava pendurado.
   */
  test("erro sem jobId rejeita os pendentes em vez de deixa-los pendurados", async () => {
    const manager = new ReportWorkerManager({
      concurrency: 1,
      workerFile: SEM_JOBID_WORKER,
      jobTimeoutMs: 10_000,
    });

    await expect(manager.generate(payload("job-orfao", "OK"))).rejects.toThrow(/Payload inv/);
    await manager.shutdown();
  }, 10_000);
});

/**
 * Estado do worker para health check: se está vivo, quantos jobs em voo, quantos reinícios e o
 * resultado dos últimos jobs. Antes, "pronto" só existia como linha de log.
 */
describe("ReportWorkerManager.status", () => {
  test("conta concluídos e falhos e diz se o worker está vivo", async () => {
    const manager = new ReportWorkerManager({ concurrency: 2, workerFile: ECHO_WORKER });
    await manager.generate(payload("st-ok", "OK"));
    await manager.generate(payload("st-bad", "FALHA")).catch(() => undefined);

    const status = manager.status();
    expect(status).toMatchObject({
      alive: true,
      shuttingDown: false,
      inFlight: 0,
      completed: 1,
      failed: 1,
      restarts: 0,
    });
    expect(typeof status.lastCompletedAt).toBe("string");
    expect(typeof status.lastFailedAt).toBe("string");
    await manager.shutdown();
  });

  test("depois do shutdown o worker não está vivo", async () => {
    const manager = new ReportWorkerManager({ concurrency: 1, workerFile: ECHO_WORKER });
    await manager.shutdown();

    expect(manager.status()).toMatchObject({ alive: false, shuttingDown: true });
  });
});

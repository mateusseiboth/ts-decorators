/**
 * Stub do pdf.worker para testes do ReportWorkerManager — sem Playwright.
 * Emite um progresso e finaliza com sucesso ou erro conforme o título.
 *
 * Usa `parentPort` pelo MESMO motivo do pdf.worker real: o manager cria o worker
 * com `worker_threads.Worker`, e `self.onmessage` nunca recebe nada no Bun. O stub
 * precisa falar a mesma língua do worker de verdade — senão o teste passa por
 * acidente com uma API que a produção não usa (foi o que escondeu o bug).
 */
import { parentPort } from "worker_threads";

const canal = parentPort!;

canal.on("message", (data: unknown) => {
  const options = JSON.parse(Buffer.from(data as Uint8Array).toString("utf-8"));
  const { jobId, title } = options;

  canal.postMessage({
    jobId,
    progress: { phase: "generating", current: 1, total: 2, percent: 50, message: "meio caminho" },
  });

  if (String(title).includes("FALHA")) {
    canal.postMessage({ jobId, error: `erro simulado em ${title}` });
    return;
  }
  canal.postMessage({ jobId, success: true, result: { parts: 2, bytes: 1234 } });
});

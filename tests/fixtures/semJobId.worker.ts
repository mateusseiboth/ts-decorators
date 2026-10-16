/** Stub que responde erro SEM jobId — simula payload que nao parseou no worker. */
import { parentPort } from "worker_threads";
parentPort!.on("message", () =>
  parentPort!.postMessage({ error: "Payload inválido do relatório: teste" }),
);

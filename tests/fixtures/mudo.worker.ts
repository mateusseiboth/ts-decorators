/** Stub que RECEBE o job e nunca responde — simula worker travado (Chrome pendurado). */
import { parentPort } from "worker_threads";
parentPort!.on("message", () => {});

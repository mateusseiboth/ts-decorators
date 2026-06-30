/**
 * Registro de filas — cola entre os decorators @Queue e @Processor.
 *
 * @Queue registra uma fila nomeada sobre um {@link QueueAdapter}. @Processor
 * registra a função consumidora dessa fila. `startProcessors()` inicia o
 * consumo (poll do adapter) respeitando a concorrência configurada.
 */

import {randomUUID} from "crypto";
import {Semaphore} from "../concurrency/Semaphore";
import type {QueueAdapter, QueueJob} from "./adapter";

interface ProcessorEntry {
  handler: (payload: any) => any | Promise<any>;
  concurrency: number;
  pollMs: number;
}

interface QueueEntry {
  name: string;
  adapter: QueueAdapter;
  processor?: ProcessorEntry;
  running: boolean;
  timer?: ReturnType<typeof setInterval>;
}

const _queues = new Map<string, QueueEntry>();

function getOrCreate(name: string): QueueEntry {
  let entry = _queues.get(name);
  if (!entry) {
    entry = {name, adapter: undefined as any, running: false};
    _queues.set(name, entry);
  }
  return entry;
}

/** Registra (ou atualiza) o adapter de uma fila. */
export function registerQueue(name: string, adapter: QueueAdapter): void {
  getOrCreate(name).adapter = adapter;
}

/** Registra a função consumidora de uma fila. */
export function registerProcessor(name: string, entry: ProcessorEntry): void {
  getOrCreate(name).processor = entry;
}

/** Enfileira um payload na fila nomeada. */
export async function enqueue<T = any>(name: string, payload: T): Promise<QueueJob<T>> {
  const entry = _queues.get(name);
  if (!entry?.adapter) throw new Error(`Fila não registrada: "${name}"`);
  const job: QueueJob<T> = {
    id: randomUUID(),
    payload,
    status: "pending",
    createdAt: Date.now(),
  };
  return entry.adapter.create(job);
}

async function drain(entry: QueueEntry, sem: Semaphore): Promise<void> {
  const pending = (await entry.adapter.findMany({status: "pending"})) as QueueJob[];
  for (const job of pending) {
    // Marca como processing imediatamente para não pegar 2x no próximo poll.
    await entry.adapter.update(job.id, {status: "processing"});
    void sem.runExclusive(async () => {
      try {
        await entry.processor!.handler(job.payload);
        await entry.adapter.update(job.id, {status: "completed"});
      } catch (err: any) {
        await entry.adapter.update(job.id, {status: "failed", error: err?.message ?? String(err)});
      }
    });
  }
}

/** Inicia o consumo de todas as filas que têm processor registrado. */
export function startProcessors(): void {
  for (const entry of _queues.values()) {
    if (!entry.processor || !entry.adapter || entry.running) continue;
    entry.running = true;
    const sem = new Semaphore(entry.processor.concurrency);
    const tick = () => void drain(entry, sem).catch((err) => console.error(`[Queue:${entry.name}]`, err));
    entry.timer = setInterval(tick, entry.processor.pollMs);
    if ((entry.timer as any).unref) (entry.timer as any).unref();
    tick();
  }
}

/** Para o consumo de todas as filas (útil em testes/shutdown). */
export function stopProcessors(): void {
  for (const entry of _queues.values()) {
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = undefined;
    entry.running = false;
  }
}

/** Acesso ao adapter de uma fila (ex.: para inspeção/testes). */
export function getQueueAdapter(name: string): QueueAdapter | undefined {
  return _queues.get(name)?.adapter;
}

/** Limpa o registro de filas (útil em testes). */
export function clearQueues(): void {
  stopProcessors();
  _queues.clear();
}

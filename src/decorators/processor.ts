/**
 * @Processor(queueName, opts?) — registra o método como consumidor de uma fila.
 *
 * A fila é identificada pelo nome definido por @Queue. O runner faz poll do
 * adapter e invoca o método para cada job pendente, respeitando a concorrência.
 *
 * O consumo começa quando a instância existe:
 *  - TC39: automático via `context.addInitializer`.
 *  - Legacy: chame `startProcessors()` após instanciar (ou resolva via container).
 *
 * Uso:
 *   @Processor("reports", { concurrency: 3 })
 *   async handle(payload) { ... }   // payload de cada job
 */

import "reflect-metadata";
import {isDecoratorContext, warnLegacy} from "./_proxy";
import {registerProcessor, startProcessors} from "../queue/registry";

const PROCESSOR_KEY = "queue:processors";
const _started = new WeakSet<object>();

export interface ProcessorOptions {
  /** Máximo de jobs processados em paralelo. Default: 1. */
  concurrency?: number;
  /** Intervalo de poll do adapter em ms. Default: 1000. */
  pollMs?: number;
  /**
   * Extrai a chave de serialização do payload. Jobs com a MESMA chave nunca rodam
   * em paralelo (no máx. 1 em voo); um 2º job da mesma chave fica "pending" e não
   * ocupa vaga. Ex.: `keyOf: (p) => p.ctx.entCodigo` serializa por entidade.
   */
  keyOf?: (payload: any) => string | number | undefined;
}

interface ProcessorMeta {
  queueName: string;
  methodName: string;
  concurrency: number;
  pollMs: number;
  keyOf?: (payload: any) => string | number | undefined;
}

function register(instance: any, meta: ProcessorMeta): void {
  registerProcessor(meta.queueName, {
    handler: (payload: any) => instance[meta.methodName](payload),
    concurrency: meta.concurrency,
    pollMs: meta.pollMs,
    keyOf: meta.keyOf,
  });
}

/** Registra e inicia os @Processor declarados na instância. */
export function initProcessors(instance: any): void {
  if (!instance || _started.has(instance)) return;
  const list: ProcessorMeta[] = Reflect.getMetadata(PROCESSOR_KEY, instance.constructor) ?? [];
  for (const meta of list) register(instance, meta);
  _started.add(instance);
  if (list.length > 0) startProcessors();
}

export function Processor(queueName: string, options?: ProcessorOptions) {
  const concurrency = Math.max(1, options?.concurrency ?? 1);
  const pollMs = options?.pollMs ?? 1000;
  const keyOf = options?.keyOf;

  return function (...args: any[]): any {
    // TC39 Stage 3: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const original = args[0] as Function;
      const context = args[1] as ClassMethodDecoratorContext;
      const methodName = String(context.name);
      context.addInitializer(function (this: any) {
        register(this, {queueName, methodName, concurrency, pollMs, keyOf});
        startProcessors();
      });
      return original;
    }

    // Legacy: (target, propertyKey, descriptor)
    warnLegacy("Processor");
    const target = args[0];
    const propertyKey = args[1] as string;
    const list: ProcessorMeta[] = Reflect.getMetadata(PROCESSOR_KEY, target.constructor) ?? [];
    list.push({queueName, methodName: propertyKey, concurrency, pollMs, keyOf});
    Reflect.defineMetadata(PROCESSOR_KEY, list, target.constructor);
    return args[2];
  };
}

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
 *
 *   // Cada município roda no máximo 2 jobs; a vaga livre vai para o município com menos rodando.
 *   @Processor("iptu", { concurrency: 4, perTenant: { concurrency: 2 } })
 */

import "reflect-metadata";
import { requirePerTenant, type PerTenantOptions } from "../queue/perTenant";
import { registerProcessor, startProcessors } from "../queue/registry";
import { appendMetadataItem } from "./_metadataList";
import { isDecoratorContext, warnLegacy } from "./_proxy";

const PROCESSOR_KEY = "queue:processors";
const _started = new WeakSet<object>();

export interface ProcessorOptions {
  /** Máximo de jobs processados em paralelo. Default: 1. */
  concurrency?: number;
  /** Intervalo de poll do adapter em ms. Default: 1000. */
  pollMs?: number;
  /**
   * Extrai a chave de serialização do payload. Jobs com a MESMA chave rodam no máx.
   * `maxPerKey` em paralelo (default 1: nunca em paralelo); o job que excede o limite
   * da chave fica "pending" e não ocupa vaga. Ex.: `keyOf: (p) => p.ctx.tenant`
   * serializa por tenant.
   */
  keyOf?: (payload: any) => string | number | undefined;
  /**
   * Quantos jobs da MESMA chave podem estar em voo ao mesmo tempo. Default: 1. Só vale
   * com `keyOf`. Ex.: `{ keyOf: (p) => p.ctx.entidade, maxPerKey: 3 }` deixa cada
   * tenant rodar até 3 juntos, e a `concurrency` continua sendo o teto da fila.
   */
  maxPerKey?: number;
  /**
   * Tempo sem sinal de vida para o job "processing" ser dado como órfão (o processo que o rodava
   * caiu) e voltar para a fila. Default: 60000. Nunca menos que três ciclos de `pollMs`.
   */
  staleAfterMs?: number;
  /**
   * Concorrência por tenant: no máximo `concurrency` jobs do mesmo tenant rodando, e o worker
   * livre pega o job do tenant com menos jobs rodando, em vez de mais um do que já ocupa a fila.
   * O tenant sai de `key` (default: o do payload, nos formatos comuns). Não combina com `keyOf`.
   */
  perTenant?: PerTenantOptions;
}

interface ProcessorMeta {
  queueName: string;
  methodName: string;
  concurrency: number;
  pollMs: number;
  keyOf?: (payload: any) => string | number | undefined;
  maxPerKey: number;
  staleAfterMs?: number;
  perTenant?: PerTenantOptions;
}

function register(instance: any, meta: ProcessorMeta): void {
  registerProcessor(meta.queueName, {
    handler: (payload: any) => instance[meta.methodName](payload),
    concurrency: meta.concurrency,
    pollMs: meta.pollMs,
    keyOf: meta.keyOf,
    maxPerKey: meta.maxPerKey,
    staleAfterMs: meta.staleAfterMs,
    perTenant: meta.perTenant,
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
  const maxPerKey = Math.max(1, options?.maxPerKey ?? 1);
  const staleAfterMs = options?.staleAfterMs;
  const perTenant = options?.perTenant;
  requirePerTenant("@Processor", { perTenant, keyOf });

  return function (...args: any[]): any {
    // TC39 Stage 3: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const original = args[0] as Function;
      const context = args[1] as ClassMethodDecoratorContext;
      const methodName = String(context.name);
      context.addInitializer(function (this: any) {
        register(this, {
          queueName,
          methodName,
          concurrency,
          pollMs,
          keyOf,
          maxPerKey,
          staleAfterMs,
          perTenant,
        });
        startProcessors();
      });
      return original;
    }

    // Legacy: (target, propertyKey, descriptor)
    warnLegacy("Processor");
    const target = args[0];
    const propertyKey = args[1] as string;
    appendMetadataItem<ProcessorMeta>(PROCESSOR_KEY, target.constructor, {
      queueName,
      methodName: propertyKey,
      concurrency,
      pollMs,
      keyOf,
      maxPerKey,
      staleAfterMs,
      perTenant,
    });
    return args[2];
  };
}

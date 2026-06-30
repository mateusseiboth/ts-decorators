/**
 * @Queue({ name, adapter }) — declara uma fila nomeada sobre um QueueAdapter.
 *
 * O adapter pode ser qualquer objeto que implemente a interface comum
 * (findMany/findUnique/create/update/delete): memória, SQLite, Redis, etc.
 *
 * A classe decorada ganha um método `enqueue(payload)` (no protótipo) que
 * publica na fila. Um @Processor (em qualquer classe) consome essa mesma fila
 * pelo nome.
 *
 * Uso:
 *   @Queue({ name: "reports", adapter: new SqliteQueueAdapter("data/q.db", "reports") })
 *   class ReportQueue {}
 */

import {isDecoratorContext, warnLegacy} from "./_proxy";
import type {QueueAdapter} from "../queue/adapter";
import {enqueue, registerQueue} from "../queue/registry";

export interface QueueOptions {
  name: string;
  adapter: QueueAdapter;
}

export function Queue(options: QueueOptions) {
  return function <T extends {new (...args: any[]): any}>(constructor: T, context?: ClassDecoratorContext): T {
    if (!context || !isDecoratorContext(context)) {
      warnLegacy("Queue");
    }
    registerQueue(options.name, options.adapter);

    Object.defineProperty(constructor.prototype, "enqueue", {
      value: function (payload: any) {
        return enqueue(options.name, payload);
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(constructor.prototype, "queueName", {
      value: options.name,
      writable: false,
      enumerable: false,
      configurable: true,
    });

    return constructor;
  };
}

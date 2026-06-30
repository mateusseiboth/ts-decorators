/**
 * @Emit(event) — publica um evento no `eventBus` após o método resolver.
 *
 * O payload emitido é `{ result, args, instance }`. Erros NÃO são suprimidos:
 * se o método lançar, o evento não é emitido e o erro propaga.
 *
 * Uso:
 *   @Emit("report.requested")
 *   async enqueue(job) { ...; return job; }
 */

import {eventBus} from "../events/eventBus";
import {makeMethodDecorator} from "./_method";

export function Emit(event: string) {
  return makeMethodDecorator("Emit", (original) => {
    return async function (this: any, ...args: any[]) {
      const result = await original.apply(this, args);
      eventBus.emit(event, {result, args, instance: this});
      return result;
    };
  });
}

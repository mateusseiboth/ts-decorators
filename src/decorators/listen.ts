/**
 * @Listen(event) — registra o método como listener do `eventBus`.
 *
 * Como o handler precisa de uma instância (`this`), a assinatura acontece quando
 * a instância existe:
 *  - TC39 Stage 3: automaticamente, via `context.addInitializer` (no construtor).
 *  - Legacy (experimentalDecorators): chame `initListeners(instance)` após criar
 *    a instância (ou resolva via `container.get`, que já o faz).
 *
 * Uso:
 *   @Listen("report.requested")
 *   async onReportRequested({ result }) { ... }
 */

import "reflect-metadata";
import {eventBus} from "../events/eventBus";
import {isDecoratorContext, warnLegacy} from "./_proxy";

const LISTENERS_KEY = "events:listeners";
const _initialized = new WeakSet<object>();

interface ListenerMeta {
  event: string;
  methodName: string;
}

function addListenerMeta(ctor: any, meta: ListenerMeta): void {
  const list: ListenerMeta[] = Reflect.getMetadata(LISTENERS_KEY, ctor) ?? [];
  list.push(meta);
  Reflect.defineMetadata(LISTENERS_KEY, list, ctor);
}

/** Assina no eventBus todos os métodos marcados com @Listen na instância. */
export function initListeners(instance: any): void {
  if (!instance || _initialized.has(instance)) return;
  const ctor = instance.constructor;
  const list: ListenerMeta[] = Reflect.getMetadata(LISTENERS_KEY, ctor) ?? [];
  for (const {event, methodName} of list) {
    eventBus.on(event, (payload) => instance[methodName](payload));
  }
  _initialized.add(instance);
}

export function Listen(event: string) {
  return function (...args: any[]): any {
    // TC39 Stage 3: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const original = args[0] as Function;
      const context = args[1] as ClassMethodDecoratorContext;
      const methodName = String(context.name);
      context.addInitializer(function (this: any) {
        eventBus.on(event, (payload) => original.call(this, payload));
      });
      return original;
    }

    // Legacy: (target, propertyKey, descriptor)
    warnLegacy("Listen");
    const target = args[0];
    const propertyKey = args[1] as string;
    addListenerMeta(target.constructor, {event, methodName: propertyKey});
    return args[2];
  };
}

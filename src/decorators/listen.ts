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
import { eventBus, type EventHandler } from "../events/eventBus";
import { appendMetadataItem } from "./_metadataList";
import { isDecoratorContext } from "./_proxy";

const LISTENERS_KEY = "events:listeners";

interface ListenerMeta {
  event: string;
  methodName: string;
}

interface Subscription {
  event: string;
  handler: EventHandler;
}

/**
 * Assinaturas vivas por instância.
 *
 * Sem isso, toda instância de uma classe com @Listen deixava um handler para
 * sempre no eventBus: em classe `scoped`/`transient` (uma por request) o
 * barramento crescia sem limite e cada `emit` chamava também os objetos mortos.
 */
const _subscriptions = new WeakMap<object, Subscription[]>();

function addListenerMeta(ctor: any, meta: ListenerMeta): void {
  appendMetadataItem(LISTENERS_KEY, ctor, meta);
}

/** Assina `handler` e guarda o vínculo para o {@link disposeListeners}. */
export function trackSubscription(instance: object, event: string, handler: EventHandler): void {
  const list = _subscriptions.get(instance) ?? [];
  list.push({ event, handler });
  _subscriptions.set(instance, list);
  eventBus.on(event, handler);
}

/** `true` se a instância tem assinatura ativa no barramento. */
export function hasListeners(instance: any): boolean {
  return !!instance && (_subscriptions.get(instance)?.length ?? 0) > 0;
}

/** Assina no eventBus todos os métodos marcados com @Listen na instância. */
export function initListeners(instance: any): void {
  if (!instance || _subscriptions.has(instance)) return;
  const ctor = instance.constructor;
  const list: ListenerMeta[] = Reflect.getMetadata(LISTENERS_KEY, ctor) ?? [];
  if (!list.length) return;
  for (const { event, methodName } of list) {
    trackSubscription(instance, event, (payload) => instance[methodName](payload));
  }
}

/**
 * Cancela todas as assinaturas da instância. Chame ao descartar um objeto de
 * escopo/transient — o `container` já faz isso em `clearScope`/`clear`.
 */
export function disposeListeners(instance: any): void {
  const list = _subscriptions.get(instance);
  if (!list) return;
  for (const { event, handler } of list) eventBus.off(event, handler);
  _subscriptions.delete(instance);
}

export function Listen(event: string) {
  return function (...args: any[]): any {
    // TC39 Stage 3: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const original = args[0] as Function;
      const context = args[1] as ClassMethodDecoratorContext;
      context.addInitializer(function (this: any) {
        trackSubscription(this, event, (payload) => original.call(this, payload));
      });
      return original;
    }

    // Legacy: (target, propertyKey, descriptor)
    const target = args[0];
    const propertyKey = args[1] as string;
    addListenerMeta(target.constructor, { event, methodName: propertyKey });
    return args[2];
  };
}

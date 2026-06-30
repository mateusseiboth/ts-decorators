/**
 * EventBus — barramento de eventos singleton sobre o EventEmitter do Node.
 *
 * Base dos decorators @Emit (publica) e @Listen (assina). Use a instância
 * exportada `eventBus` para garantir um único barramento por processo.
 *
 * Exemplo:
 * ```ts
 * eventBus.on("user.created", (payload) => { ... });
 * eventBus.emit("user.created", { id: 1 });
 * ```
 */

import {EventEmitter} from "events";

export type EventHandler = (payload: any) => void | Promise<void>;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Relatórios/filas podem registrar muitos listeners — evita o warning de leak.
    this.emitter.setMaxListeners(0);
  }

  emit(event: string, payload?: any): boolean {
    return this.emitter.emit(event, payload);
  }

  on(event: string, handler: EventHandler): this {
    this.emitter.on(event, handler);
    return this;
  }

  once(event: string, handler: EventHandler): this {
    this.emitter.once(event, handler);
    return this;
  }

  off(event: string, handler: EventHandler): this {
    this.emitter.off(event, handler);
    return this;
  }

  removeAllListeners(event?: string): this {
    this.emitter.removeAllListeners(event);
    return this;
  }

  listenerCount(event: string): number {
    return this.emitter.listenerCount(event);
  }
}

/** Barramento de eventos compartilhado por todo o processo. */
export const eventBus = new EventBus();

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import "reflect-metadata";

import { container } from "../src/decorators/container";
import { Cron, stopAllCronJobs, stopCronJobs } from "../src/decorators/cron";
import { Scoped, Transient } from "../src/decorators/lifecycle";
import { Listen, disposeListeners, initListeners } from "../src/decorators/listen";
import { eventBus } from "../src/events/eventBus";
import { captureWarnings } from "./_helpers";

describe("ciclo de vida das instâncias assinantes", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    warnCap = captureWarnings();
    container.clear();
    eventBus.removeAllListeners();
  });
  afterEach(() => {
    warnCap.restore();
    stopAllCronJobs();
    eventBus.removeAllListeners();
    container.clear();
  });

  test("disposeListeners cancela a assinatura da instância", () => {
    const recebidos: any[] = [];

    class Ouvinte {
      @Listen("lifecycle.ping")
      onLifecyclePing(payload: any) {
        recebidos.push(payload);
      }
    }

    const instance = new Ouvinte();
    initListeners(instance);
    eventBus.emit("lifecycle.ping", 1);
    expect(recebidos).toEqual([1]);

    disposeListeners(instance);
    eventBus.emit("lifecycle.ping", 2);
    expect(recebidos).toEqual([1]);
    expect(eventBus.listenerCount("lifecycle.ping")).toBe(0);
  });

  test("initListeners duas vezes não duplica a assinatura", () => {
    const recebidos: any[] = [];

    class Ouvinte {
      @Listen("dup")
      onDup(p: any) {
        recebidos.push(p);
      }
    }

    const instance = new Ouvinte();
    initListeners(instance);
    initListeners(instance);
    eventBus.emit("dup", "x");
    expect(recebidos).toEqual(["x"]);
  });

  test("instância descartada e reassinada volta a funcionar", () => {
    const recebidos: any[] = [];

    class Ouvinte {
      @Listen("ciclo")
      onCiclo(p: any) {
        recebidos.push(p);
      }
    }

    const instance = new Ouvinte();
    initListeners(instance);
    disposeListeners(instance);
    initListeners(instance);
    eventBus.emit("ciclo", 1);
    expect(recebidos).toEqual([1]);
  });

  test("clearScope descarta os listeners das instâncias daquele escopo", () => {
    let contador = 0;

    @Scoped(() => "req-1")
    class ServicoDoRequest {
      @Listen("req.evento")
      onEvento() {
        contador++;
      }
    }

    container.get(ServicoDoRequest);
    expect(eventBus.listenerCount("req.evento")).toBe(1);

    container.clearScope("req-1");
    eventBus.emit("req.evento", {});
    expect(contador).toBe(0);
    expect(eventBus.listenerCount("req.evento")).toBe(0);
  });

  test("container.clear descarta listeners de singletons", () => {
    class ServicoGlobal {
      @Listen("global.evento")
      onEvento() {}
    }

    container.get(ServicoGlobal);
    expect(eventBus.listenerCount("global.evento")).toBe(1);

    container.clear();
    expect(eventBus.listenerCount("global.evento")).toBe(0);
  });

  test("@Listen em classe @Transient avisa — ninguém vai cancelar a assinatura", () => {
    @Transient()
    class Efemero {
      @Listen("efemero.evento")
      onEvento() {}
    }

    container.get(Efemero);
    container.get(Efemero);

    expect(warnCap.warnings.some((w) => w.includes("Efemero"))).toBe(true);
  });

  test("stopCronJobs para os timers só daquela instância", () => {
    class ComCron {
      @Cron(10_000)
      async tarefa() {}
    }

    const a = new ComCron();
    const b = new ComCron();
    // Sem descarte, cada instância deixaria um setInterval vivo para sempre.
    expect(() => {
      stopCronJobs(a);
      stopCronJobs(b);
    }).not.toThrow();
  });
});

/**
 * Decorators legados que guardam uma lista no metadado da classe: decorar a SUBCLASSE não pode
 * mexer na lista da classe base. O `Reflect.getMetadata` devolve a lista herdada, e dar `push`
 * nela alterava a da base.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { Cron } from "../src/decorators/cron";
import { disposeListeners, initListeners, Listen } from "../src/decorators/listen";
import { applyMask, MaskSensitive } from "../src/decorators/maskSensitive";
import { Processor } from "../src/decorators/processor";
import { RegistryRouter } from "../src/decorators/registry-router";
import { ROUTERS_KEY } from "../src/decorators/router-metadata";
import { eventBus } from "../src/events/eventBus";

const methodsOf = (key: unknown, target: object): string[] =>
  ((Reflect.getMetadata(key, target) as { methodName: string }[] | undefined) ?? []).map(
    (meta) => meta.methodName,
  );

afterEach(() => eventBus.removeAllListeners());

describe("herança nos decorators legados", () => {
  test("@Cron", () => {
    class Base {
      @Cron(60_000)
      limparBase() {}
    }
    class Sub extends Base {
      @Cron(60_000)
      limparSub() {}
    }
    expect(methodsOf("cron:jobs", Base)).toEqual(["limparBase"]);
    expect(methodsOf("cron:jobs", Sub)).toEqual(["limparBase", "limparSub"]);
  });

  test("@Listen: a instância da base não reage ao evento da subclasse", () => {
    const recebidos: string[] = [];
    class Base {
      @Listen("base.evento")
      onBase() {
        recebidos.push("base");
      }
    }
    class Sub extends Base {
      @Listen("sub.evento")
      onSub() {
        recebidos.push("sub");
      }
    }
    const base = new Base();
    initListeners(base);
    eventBus.emit("sub.evento");
    eventBus.emit("base.evento");
    disposeListeners(base);
    expect(recebidos).toEqual(["base"]);
    expect(Sub).toBeDefined();
  });

  test("@Processor", () => {
    class Base {
      @Processor("fila-base")
      processBase() {}
    }
    class Sub extends Base {
      @Processor("fila-sub")
      processSub() {}
    }
    expect(methodsOf("queue:processors", Base)).toEqual(["processBase"]);
    expect(methodsOf("queue:processors", Sub)).toEqual(["processBase", "processSub"]);
  });

  test("@MaskSensitive: o campo mascarado na subclasse não é mascarado na base", () => {
    class Base {
      @MaskSensitive()
      senha = "";
      cpf = "";
    }
    class Sub extends Base {
      @MaskSensitive()
      declare cpf: string;
    }
    const masked = applyMask({ senha: "segredo123", cpf: "12345678909" }, Base);
    expect(masked.cpf).toBe("12345678909");
    expect(masked.senha).not.toBe("segredo123");
    expect(applyMask({ senha: "segredo123", cpf: "12345678909" }, Sub).cpf).not.toBe("12345678909");
  });

  test("@RegistryRouter", () => {
    class Base {
      @RegistryRouter({ folder: "base" })
      routesBase() {}
    }
    class Sub extends Base {
      @RegistryRouter({ folder: "sub" })
      routesSub() {}
    }
    expect(methodsOf(ROUTERS_KEY, Base.prototype)).toEqual(["routesBase"]);
    expect(methodsOf(ROUTERS_KEY, Sub.prototype)).toEqual(["routesBase", "routesSub"]);
  });
});

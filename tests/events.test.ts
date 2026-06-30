import {afterEach, describe, expect, test} from "bun:test";
import {eventBus} from "../src/events/eventBus";
import {Emit} from "../src/decorators/emit";
import {Listen, initListeners} from "../src/decorators/listen";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("@Emit / @Listen", () => {
  afterEach(() => {
    eventBus.removeAllListeners();
  });

  test("@Emit publica o resultado no eventBus", async () => {
    let received: any;
    eventBus.on("order.created", (payload) => {
      received = payload;
    });

    class Service {
      @Emit("order.created")
      async create(id: number) {
        return {id, ok: true};
      }
    }

    const out = await new Service().create(7);
    expect(out).toEqual({id: 7, ok: true});
    expect(received.result).toEqual({id: 7, ok: true});
    expect(received.args).toEqual([7]);
  });

  test("@Listen assina o método (via initListeners) e recebe o evento", async () => {
    const seen: any[] = [];

    class Handler {
      @Listen("order.created")
      onCreated(payload: any) {
        seen.push(payload);
      }
    }

    const h = new Handler();
    initListeners(h);

    eventBus.emit("order.created", {id: 1});
    await delay(1);
    expect(seen).toEqual([{id: 1}]);
  });

  test("@Emit + @Listen integrados", async () => {
    const seen: any[] = [];

    class Producer {
      @Emit("ping")
      async fire() {
        return "pong";
      }
    }
    class Consumer {
      @Listen("ping")
      onPing(payload: any) {
        seen.push(payload.result);
      }
    }

    initListeners(new Consumer());
    await new Producer().fire();
    await delay(1);
    expect(seen).toEqual(["pong"]);
  });
});

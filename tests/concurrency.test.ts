import {describe, expect, test} from "bun:test";
import {Mutex as MutexPrimitive} from "../src/concurrency/Mutex";
import {Semaphore as SemaphorePrimitive} from "../src/concurrency/Semaphore";
import {Mutex} from "../src/decorators/mutex";
import {Semaphore, clearSemaphores} from "../src/decorators/semaphore";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Mutex primitive", () => {
  test("serializa execuções (sem sobreposição)", async () => {
    const mutex = new MutexPrimitive();
    let active = 0;
    let maxActive = 0;

    const task = () =>
      mutex.runExclusive(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active--;
      });

    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);
  });
});

describe("Semaphore primitive", () => {
  test("limita a concorrência ao limite", async () => {
    const sem = new SemaphorePrimitive(2);
    let active = 0;
    let maxActive = 0;

    const task = () =>
      sem.runExclusive(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active--;
      });

    await Promise.all(Array.from({length: 6}, task));
    expect(maxActive).toBe(2);
  });
});

describe("@Mutex decorator", () => {
  test("serializa chamadas do método", async () => {
    let active = 0;
    let maxActive = 0;

    class Service {
      @Mutex()
      async run() {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active--;
      }
    }

    const s = new Service();
    await Promise.all([s.run(), s.run(), s.run()]);
    expect(maxActive).toBe(1);
  });
});

describe("@Semaphore decorator", () => {
  test("limita a concorrência global do método", async () => {
    clearSemaphores();
    let active = 0;
    let maxActive = 0;

    class Service {
      @Semaphore({limit: 3})
      async run() {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active--;
      }
    }

    const s = new Service();
    await Promise.all(Array.from({length: 9}, () => s.run()));
    expect(maxActive).toBe(3);
  });
});

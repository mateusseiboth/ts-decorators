import {afterEach, describe, expect, test} from "bun:test";
import {InMemoryQueueAdapter} from "../src/queue/InMemoryQueueAdapter";
import {SqliteQueueAdapter} from "../src/queue/SqliteQueueAdapter";
import {Queue} from "../src/decorators/queue";
import {Processor} from "../src/decorators/processor";
import {clearQueues, getQueueAdapter, startProcessors} from "../src/queue/registry";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Queue adapters (interface comum)", () => {
  test("InMemoryQueueAdapter faz CRUD", () => {
    const a = new InMemoryQueueAdapter();
    a.create({id: "1", payload: {x: 1}, status: "pending", createdAt: 1});
    expect((a.findUnique("1") as any).payload).toEqual({x: 1});
    a.update("1", {status: "completed"});
    expect((a.findUnique("1") as any).status).toBe("completed");
    expect((a.findMany({status: "completed"}) as any[]).length).toBe(1);
    a.delete("1");
    expect(a.findUnique("1")).toBeNull();
  });

  test("SqliteQueueAdapter (memória) faz CRUD", () => {
    const a = new SqliteQueueAdapter(":memory:", "t");
    a.create({id: "1", payload: {x: 2}, status: "pending", createdAt: 1});
    expect((a.findUnique("1") as any).payload).toEqual({x: 2});
    a.update("1", {status: "failed", error: "boom"});
    expect((a.findUnique("1") as any).error).toBe("boom");
    a.delete("1");
    expect(a.findUnique("1")).toBeNull();
  });
});

describe("@Queue / @Processor", () => {
  afterEach(() => {
    clearQueues();
  });

  test("@Queue registra a fila e expõe enqueue; @Processor consome", async () => {
    const processed: any[] = [];

    @Queue({name: "jobs", adapter: new InMemoryQueueAdapter()})
    class JobsQueue {}

    class JobsWorker {
      @Processor("jobs", {concurrency: 2, pollMs: 5})
      async handle(payload: any) {
        processed.push(payload);
      }
    }

    // registra o processor (legacy: via initProcessors/startProcessors)
    const {initProcessors} = await import("../src/decorators/processor");
    initProcessors(new JobsWorker());
    startProcessors();

    const q = new JobsQueue() as any;
    await q.enqueue({task: "a"});
    await q.enqueue({task: "b"});

    await delay(60);
    expect(processed).toEqual(expect.arrayContaining([{task: "a"}, {task: "b"}]));

    const adapter = getQueueAdapter("jobs")!;
    const completed = (await adapter.findMany({status: "completed"})) as any[];
    expect(completed.length).toBe(2);
  });
});

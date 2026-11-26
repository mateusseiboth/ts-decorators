import { afterEach, describe, expect, test } from "bun:test";

import { IdempotentMethod, withIdempotency } from "../src/decorators/idempotentMethod";
import { setHandlerContext } from "../src/handlers/context";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chave = (nome: string) => `${nome}-${Math.random()}`;

afterEach(() => setHandlerContext(() => undefined));

describe("withIdempotency", () => {
  test("mesma chave em voo: as duas chamadas recebem a mesma execução", async () => {
    let execucoes = 0;
    const key = chave("voo");
    const run = () =>
      withIdempotency(key, async () => {
        execucoes++;
        await delay(10);
        return { lote: 1 };
      });

    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toEqual({ lote: 1 });
    expect(b).toBe(a);
    expect(execucoes).toBe(1);
  });

  test("concluída dentro do prazo: devolve o resultado guardado sem rodar", async () => {
    let execucoes = 0;
    const key = chave("concluida");
    const run = () => withIdempotency(key, async () => ++execucoes);

    expect(await run()).toBe(1);
    expect(await run()).toBe(1);
    expect(execucoes).toBe(1);
  });

  test("vencido o prazo, a mesma chave roda de novo", async () => {
    let execucoes = 0;
    const key = chave("prazo");
    const run = () => withIdempotency(key, async () => ++execucoes, { ttlMs: 15 });

    expect(await run()).toBe(1);
    await delay(30);
    expect(await run()).toBe(2);
  });

  test("falha não é guardada: a próxima chamada roda de novo", async () => {
    let execucoes = 0;
    const erro = new Error("fila fora do ar");
    const key = chave("falha");
    const run = () =>
      withIdempotency(key, async () => {
        execucoes++;
        if (execucoes === 1) throw erro;
        return "ok";
      });

    await expect(run()).rejects.toBe(erro);
    expect(await run()).toBe("ok");
    expect(execucoes).toBe(2);
  });

  test("erro síncrono vira rejeição e também não fica guardado", async () => {
    const key = chave("sincrono");
    const erro = new Error("síncrono");
    await expect(
      withIdempotency(key, () => {
        throw erro;
      }),
    ).rejects.toBe(erro);
    expect(await withIdempotency(key, () => 3)).toBe(3);
  });

  test("a entidade do contexto entra na chave", async () => {
    let execucoes = 0;
    const key = chave("entidade");
    const runNa = (entity: number) => {
      setHandlerContext(() => ({ entity }));
      return withIdempotency(key, async () => ++execucoes);
    };

    expect(await runNa(1)).toBe(1);
    expect(await runNa(2)).toBe(2);
    expect(await runNa(1)).toBe(1);
    expect(execucoes).toBe(2);
  });

  test("ttlMs inválido lança na chamada", () => {
    expect(() => withIdempotency("x", () => 1, { ttlMs: 0 })).toThrow(RangeError);
  });
});

describe("@IdempotentMethod", () => {
  test("mensagem entregue duas vezes processa uma vez só", async () => {
    let processadas = 0;
    class PagamentoConsumer {
      @IdempotentMethod({ key: (mensagem: { id: string }) => mensagem.id })
      async onPagamento(mensagem: { id: string; valor: number }) {
        processadas++;
        await delay(5);
        return `baixa ${mensagem.valor}`;
      }
    }

    const consumer = new PagamentoConsumer();
    const id = chave("msg");
    const [a, b] = await Promise.all([
      consumer.onPagamento({ id, valor: 10 }),
      consumer.onPagamento({ id, valor: 10 }),
    ]);
    const c = await consumer.onPagamento({ id, valor: 10 });
    expect([a, b, c]).toEqual(["baixa 10", "baixa 10", "baixa 10"]);
    expect(processadas).toBe(1);
  });

  test("a chave é por classe e por método", async () => {
    let execucoes = 0;
    const id = chave("escopo");
    class A {
      @IdempotentMethod({ key: (k: string) => k })
      async run(_k: string) {
        return ++execucoes;
      }

      @IdempotentMethod({ key: (k: string) => k })
      async outro(_k: string) {
        return ++execucoes;
      }
    }
    class B {
      @IdempotentMethod({ key: (k: string) => k })
      async run(_k: string) {
        return ++execucoes;
      }
    }

    await new A().run(id);
    await new A().outro(id);
    await new B().run(id);
    expect(execucoes).toBe(3);
  });

  test("o método async continua async", () => {
    class Job {
      @IdempotentMethod({ key: () => "k" })
      async run() {
        return 1;
      }
    }
    expect(Job.prototype.run.constructor.name).toBe("AsyncFunction");
  });

  test("sem key lança ao decorar", () => {
    expect(() => IdempotentMethod({} as never)).toThrow(TypeError);
  });

  test("ttlMs inválido lança ao decorar", () => {
    expect(() => IdempotentMethod({ key: () => "k", ttlMs: -1 })).toThrow(RangeError);
  });
});

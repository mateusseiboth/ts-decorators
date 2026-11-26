import { describe, expect, test } from "bun:test";

import { SingleFlight, withSingleFlight } from "../src/decorators/singleFlight";
import { fakeMethodContext } from "./_helpers";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withSingleFlight", () => {
  test("chamadas simultâneas com a mesma chave recebem a mesma promessa", async () => {
    let execucoes = 0;
    const findCotacao = () =>
      withSingleFlight("cotacao:usd", async () => {
        execucoes++;
        await delay(10);
        return 5.4;
      });

    const primeira = findCotacao();
    const segunda = findCotacao();
    expect(segunda).toBe(primeira);
    expect(await Promise.all([primeira, segunda])).toEqual([5.4, 5.4]);
    expect(execucoes).toBe(1);
  });

  test("terminada a chamada, a próxima roda de novo (não é cache)", async () => {
    let execucoes = 0;
    const run = () => withSingleFlight("chave", async () => ++execucoes);

    expect(await run()).toBe(1);
    expect(await run()).toBe(2);
  });

  test("a rejeição é a mesma para todos e libera a chave", async () => {
    let execucoes = 0;
    const erro = new Error("fora do ar");
    const run = () =>
      withSingleFlight("falha", async () => {
        execucoes++;
        await delay(5);
        throw erro;
      });

    const resultados = await Promise.allSettled([run(), run()]);
    expect(resultados).toEqual([
      { status: "rejected", reason: erro },
      { status: "rejected", reason: erro },
    ]);
    expect(execucoes).toBe(1);
    await expect(run()).rejects.toBe(erro);
    expect(execucoes).toBe(2);
  });

  test("função síncrona: valor vira promessa e erro vira rejeição", async () => {
    const erro = new Error("síncrono");
    expect(await withSingleFlight("sync", () => 3)).toBe(3);
    await expect(
      withSingleFlight("sync-erro", () => {
        throw erro;
      }),
    ).rejects.toBe(erro);
  });

  test("chaves diferentes rodam separadas", async () => {
    let execucoes = 0;
    const run = (key: string) => withSingleFlight(key, async () => ++execucoes);
    await Promise.all([run("a"), run("b")]);
    expect(execucoes).toBe(2);
  });
});

describe("@SingleFlight", () => {
  test("argumentos iguais compartilham a execução", async () => {
    let execucoes = 0;
    class CotacaoService {
      @SingleFlight()
      async findCotacao(moeda: string) {
        execucoes++;
        await delay(10);
        return `${moeda}:5.4`;
      }
    }

    const service = new CotacaoService();
    const [a, b, c] = await Promise.all([
      service.findCotacao("usd"),
      service.findCotacao("usd"),
      service.findCotacao("eur"),
    ]);
    expect([a, b, c]).toEqual(["usd:5.4", "usd:5.4", "eur:5.4"]);
    expect(execucoes).toBe(2);
  });

  test("a chave é por classe e por método", async () => {
    let execucoes = 0;
    class A {
      @SingleFlight()
      async run(id: number) {
        execucoes++;
        await delay(5);
        return id;
      }
    }
    class B {
      @SingleFlight()
      async run(id: number) {
        execucoes++;
        await delay(5);
        return id;
      }
    }

    await Promise.all([new A().run(1), new B().run(1)]);
    expect(execucoes).toBe(2);
  });

  test("key escolhe a chave a partir dos argumentos", async () => {
    let execucoes = 0;
    class ImovelService {
      @SingleFlight({ key: (inscricao: string) => inscricao })
      async findImovel(inscricao: string, _origem: string) {
        execucoes++;
        await delay(5);
        return inscricao;
      }
    }

    const service = new ImovelService();
    await Promise.all([
      service.findImovel("01.02", "tela"),
      service.findImovel("01.02", "relatorio"),
    ]);
    expect(execucoes).toBe(1);
  });

  test("TC39: envolve o método recebido com o contexto", async () => {
    let execucoes = 0;
    class CotacaoService {}
    const findCotacao = async () => {
      execucoes++;
      await delay(5);
      return 1;
    };

    const envolvido = SingleFlight()(findCotacao, fakeMethodContext("findCotacao"));
    const service = new CotacaoService();
    expect(await Promise.all([envolvido.call(service), envolvido.call(service)])).toEqual([1, 1]);
    expect(execucoes).toBe(1);
  });
});

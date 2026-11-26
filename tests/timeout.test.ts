import { describe, expect, test } from "bun:test";

import { Retry } from "../src/decorators/retry";
import { Timeout, TimeoutError, getTimeoutSignal, withTimeout } from "../src/decorators/timeout";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withTimeout", () => {
  test("devolve o resultado quando termina a tempo", async () => {
    expect(await withTimeout(async () => "ok", 50)).toBe("ok");
  });

  test("rejeita com TimeoutError e aborta o sinal", async () => {
    let sinal: AbortSignal | undefined;

    const erro = await withTimeout(
      async (signal) => {
        sinal = signal;
        await delay(50);
        return "tarde";
      },
      5,
      "findCnpj",
    ).catch((e) => e);

    expect(erro).toBeInstanceOf(TimeoutError);
    expect((erro as TimeoutError).operation).toBe("findCnpj");
    expect((erro as TimeoutError).timeoutMs).toBe(5);
    expect((erro as TimeoutError).message).toBe("findCnpj passou de 5 ms.");
    expect(sinal?.aborted).toBe(true);
    expect(sinal?.reason).toBe(erro);
  });

  test("o erro da própria função passa sem mudança", async () => {
    const original = new Error("recusado");
    const erro = await withTimeout(async () => Promise.reject(original), 50).catch((e) => e);
    expect(erro).toBe(original);
  });

  test("erro síncrono da função vira rejeição", async () => {
    const erro = await withTimeout(() => {
      throw new Error("síncrono");
    }, 50).catch((e) => e);
    expect((erro as Error).message).toBe("síncrono");
  });

  test("o sinal não é abortado quando termina a tempo", async () => {
    let sinal: AbortSignal | undefined;
    await withTimeout(async (signal) => {
      sinal = signal;
    }, 50);
    expect(sinal?.aborted).toBe(false);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "tempo inválido %p rejeita",
    async (ms) => {
      const erro = await withTimeout(async () => 1, ms).catch((e) => e);
      expect(erro).toBeInstanceOf(Error);
      expect(erro).not.toBeInstanceOf(TimeoutError);
    },
  );
});

describe("getTimeoutSignal", () => {
  test("fora de um timeout devolve undefined", () => {
    expect(getTimeoutSignal()).toBeUndefined();
  });

  test("dentro devolve o sinal da chamada, mesmo depois de await", async () => {
    let dentro: AbortSignal | undefined;
    let recebido: AbortSignal | undefined;

    await withTimeout(async (signal) => {
      recebido = signal;
      await delay(1);
      dentro = getTimeoutSignal();
    }, 50);

    expect(dentro).toBe(recebido!);
    expect(getTimeoutSignal()).toBeUndefined();
  });

  test("com timeouts aninhados devolve o mais interno", async () => {
    let externo: AbortSignal | undefined;
    let interno: AbortSignal | undefined;
    let visto: AbortSignal | undefined;
    let depois: AbortSignal | undefined;

    await withTimeout(async (signalExterno) => {
      externo = signalExterno;
      await withTimeout(async (signalInterno) => {
        interno = signalInterno;
        visto = getTimeoutSignal();
      }, 50);
      depois = getTimeoutSignal();
    }, 50);

    expect(visto).toBe(interno!);
    expect(depois).toBe(externo!);
  });
});

describe("@Timeout", () => {
  test("corta o método e usa Classe.metodo como operação", async () => {
    class ReceitaClient {
      @Timeout(5)
      async findCnpj() {
        await delay(50);
        return "tarde";
      }
    }

    const erro = await new ReceitaClient().findCnpj().catch((e) => e);
    expect(erro).toBeInstanceOf(TimeoutError);
    expect((erro as TimeoutError).operation).toBe("ReceitaClient.findCnpj");
  });

  test("mantém o this e expõe o sinal ao método", async () => {
    class ReceitaClient {
      base = "receita";

      @Timeout(50)
      async findCnpj(cnpj: string) {
        return `${this.base}:${cnpj}:${getTimeoutSignal() instanceof AbortSignal}`;
      }
    }

    expect(await new ReceitaClient().findCnpj("123")).toBe("receita:123:true");
  });

  test("tempo inválido lança ao decorar", () => {
    expect(() => Timeout(0)).toThrow();
  });

  test("@Retry acima do @Timeout: cada tentativa tem o próprio tempo", async () => {
    const sinais: AbortSignal[] = [];

    class Integracao {
      chamadas = 0;

      @Retry({ attempts: 3, delayMs: 1, jitter: false })
      @Timeout(10)
      async send() {
        this.chamadas++;
        sinais.push(getTimeoutSignal()!);
        if (this.chamadas < 3) await delay(50);
        return this.chamadas;
      }
    }

    const integracao = new Integracao();
    expect(await integracao.send()).toBe(3);
    expect(sinais).toHaveLength(3);
    expect(new Set(sinais).size).toBe(3);
    expect(sinais.map((sinal) => sinal.aborted)).toEqual([true, true, false]);
  });
});

describe("withTimeout segura o processo até o prazo", () => {
  test("operação sem nada que segure o processo ainda estoura o prazo", async () => {
    const script = `
      import { withTimeout } from "${import.meta.dir}/../src/decorators/timeout";
      void withTimeout(() => new Promise(() => {}), 50).catch((e) => console.log(e.name));
    `;
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const saida = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(saida.trim()).toBe("TimeoutError");
  });
});

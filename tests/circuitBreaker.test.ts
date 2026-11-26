import { beforeEach, describe, expect, test } from "bun:test";

import {
  CircuitBreaker,
  CircuitOpenError,
  getCircuits,
  resetCircuits,
  withCircuitBreaker,
} from "../src/decorators/circuitBreaker";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const throwFalha = async (): Promise<never> => {
  throw new Error("fora do ar");
};

const findCircuito = (name: string) => getCircuits().find((circuito) => circuito.name === name);

/** Faz `vezes` chamadas que falham, ignorando o erro. */
const failVezes = async (name: string, vezes: number, opcoes = {}) => {
  for (let i = 0; i < vezes; i++) {
    await withCircuitBreaker(name, throwFalha, opcoes).catch(() => undefined);
  }
};

beforeEach(() => resetCircuits());

describe("withCircuitBreaker", () => {
  test("fechado, devolve o resultado", async () => {
    expect(await withCircuitBreaker("receita", async () => "ok")).toBe("ok");
    expect(findCircuito("receita")).toEqual({ name: "receita", state: "closed", failures: 0 });
  });

  test("abre depois de N falhas seguidas", async () => {
    await failVezes("esocial", 2, { failureThreshold: 3 });
    expect(findCircuito("esocial")?.state).toBe("closed");
    expect(findCircuito("esocial")?.failures).toBe(2);

    const antes = Date.now();
    await failVezes("esocial", 1, { failureThreshold: 3 });

    const circuito = findCircuito("esocial");
    expect(circuito?.state).toBe("open");
    expect(circuito?.failures).toBe(3);
    expect(circuito?.openedAt).toBeGreaterThanOrEqual(antes);
  });

  test("um sucesso fechado zera as falhas seguidas", async () => {
    await failVezes("esocial", 2, { failureThreshold: 3 });
    await withCircuitBreaker("esocial", async () => "ok", { failureThreshold: 3 });
    await failVezes("esocial", 2, { failureThreshold: 3 });

    expect(findCircuito("esocial")).toEqual({ name: "esocial", state: "closed", failures: 2 });
  });

  test("aberto, falha na hora sem chamar a função", async () => {
    await failVezes("esocial", 1, { failureThreshold: 1, resetAfterMs: 5_000 });
    let chamadas = 0;

    const erro = await withCircuitBreaker(
      "esocial",
      async () => {
        chamadas++;
      },
      { failureThreshold: 1, resetAfterMs: 5_000 },
    ).catch((e) => e);

    expect(erro).toBeInstanceOf(CircuitOpenError);
    expect((erro as CircuitOpenError).circuit).toBe("esocial");
    expect((erro as CircuitOpenError).retryAfterMs).toBeGreaterThan(4_000);
    expect((erro as CircuitOpenError).retryAfterMs).toBeLessThanOrEqual(5_000);
    expect((erro as CircuitOpenError).message).toBe(
      "O circuito esocial está aberto. Tente de novo em 5 s.",
    );
    expect(chamadas).toBe(0);
  });

  test("passado o tempo, a chamada de teste que dá certo fecha o circuito", async () => {
    const opcoes = { failureThreshold: 1, resetAfterMs: 10 };
    await failVezes("esocial", 1, opcoes);
    await delay(15);

    expect(await withCircuitBreaker("esocial", async () => "voltou", opcoes)).toBe("voltou");
    expect(findCircuito("esocial")).toEqual({ name: "esocial", state: "closed", failures: 0 });
  });

  test("a chamada de teste que falha abre de novo, com novo openedAt", async () => {
    const opcoes = { failureThreshold: 1, resetAfterMs: 10 };
    await failVezes("esocial", 1, opcoes);
    const primeiraAbertura = findCircuito("esocial")?.openedAt ?? 0;
    await delay(15);

    await failVezes("esocial", 1, opcoes);

    const circuito = findCircuito("esocial");
    expect(circuito?.state).toBe("open");
    expect(circuito?.openedAt).toBeGreaterThan(primeiraAbertura);
    const erro = await withCircuitBreaker("esocial", async () => "x", opcoes).catch((e) => e);
    expect(erro).toBeInstanceOf(CircuitOpenError);
  });

  test("meio-aberto deixa passar UMA chamada de teste; as outras falham na hora", async () => {
    const opcoes = { failureThreshold: 1, resetAfterMs: 10 };
    await failVezes("esocial", 1, opcoes);
    await delay(15);
    let chamadas = 0;
    const lenta = async () => {
      chamadas++;
      await delay(20);
      return "ok";
    };

    const teste = withCircuitBreaker("esocial", lenta, opcoes);
    expect(findCircuito("esocial")?.state).toBe("half-open");
    const concorrente = await withCircuitBreaker("esocial", lenta, opcoes).catch((e) => e);

    expect(concorrente).toBeInstanceOf(CircuitOpenError);
    expect(await teste).toBe("ok");
    expect(chamadas).toBe(1);
    expect(findCircuito("esocial")?.state).toBe("closed");
  });

  test("erro que isFailure rejeita passa sem contar falha", async () => {
    const isFailure = (erro: unknown) => !(erro instanceof RangeError);
    const opcoes = { failureThreshold: 1, isFailure };

    const erro = await withCircuitBreaker(
      "esocial",
      async () => {
        throw new RangeError("dado inválido");
      },
      opcoes,
    ).catch((e) => e);

    expect(erro).toBeInstanceOf(RangeError);
    expect(findCircuito("esocial")).toEqual({ name: "esocial", state: "closed", failures: 0 });
  });

  test("erro que não é falha na chamada de teste libera o teste sem mudar o estado", async () => {
    const isFailure = (erro: unknown) => !(erro instanceof RangeError);
    const opcoes = { failureThreshold: 1, resetAfterMs: 10, isFailure };
    await failVezes("esocial", 1, opcoes);
    await delay(15);

    await withCircuitBreaker(
      "esocial",
      async () => {
        throw new RangeError("dado inválido");
      },
      opcoes,
    ).catch(() => undefined);

    expect(findCircuito("esocial")?.state).toBe("half-open");
    expect(await withCircuitBreaker("esocial", async () => "ok", opcoes)).toBe("ok");
    expect(findCircuito("esocial")?.state).toBe("closed");
  });

  test("getCircuits devolve os circuitos em ordem de nome", async () => {
    await withCircuitBreaker("receita", async () => 1);
    await withCircuitBreaker("email", async () => 1);
    await withCircuitBreaker("esocial", async () => 1);

    expect(getCircuits().map((circuito) => circuito.name)).toEqual(["email", "esocial", "receita"]);
  });

  test("resetCircuits limpa tudo", async () => {
    await failVezes("esocial", 1, { failureThreshold: 1 });
    resetCircuits();
    expect(getCircuits()).toEqual([]);
  });

  test.each([
    [{ failureThreshold: 0 }, "failureThreshold"],
    [{ failureThreshold: 1.5 }, "failureThreshold"],
    [{ resetAfterMs: -1 }, "resetAfterMs"],
  ])("opção inválida %p rejeita citando %s", async (opcoes, campo) => {
    const erro = await withCircuitBreaker("x", async () => 1, opcoes).catch((e) => e);
    expect((erro as Error).message).toContain(campo);
  });

  test("nome vazio rejeita", async () => {
    const erro = await withCircuitBreaker("", async () => 1).catch((e) => e);
    expect(erro).toBeInstanceOf(Error);
  });
});

describe("@CircuitBreaker", () => {
  test("usa Classe.metodo como nome, mantém o this e abre", async () => {
    class ClienteEsocial {
      url = "esocial";

      @CircuitBreaker({ failureThreshold: 2, resetAfterMs: 5_000 })
      async sendLote(ok: boolean) {
        if (!ok) throw new Error(`${this.url} fora do ar`);
        return `${this.url} ok`;
      }
    }

    const cliente = new ClienteEsocial();
    expect(await cliente.sendLote(true)).toBe("esocial ok");
    await cliente.sendLote(false).catch(() => undefined);
    await cliente.sendLote(false).catch(() => undefined);

    expect(findCircuito("ClienteEsocial.sendLote")?.state).toBe("open");
    expect(await cliente.sendLote(true).catch((e) => e)).toBeInstanceOf(CircuitOpenError);
  });

  test("o mesmo nome compartilha o estado entre métodos", async () => {
    class Receita {
      @CircuitBreaker({ name: "receita", failureThreshold: 2 })
      async findCnpj() {
        throw new Error("fora do ar");
      }

      @CircuitBreaker({ name: "receita", failureThreshold: 2 })
      async findCpf() {
        return "ok";
      }
    }

    const receita = new Receita();
    await receita.findCnpj().catch(() => undefined);
    await receita.findCnpj().catch(() => undefined);

    expect(await receita.findCpf().catch((e) => e)).toBeInstanceOf(CircuitOpenError);
    expect(getCircuits().map((circuito) => circuito.name)).toEqual(["receita"]);
  });

  test("opção inválida lança ao decorar", () => {
    expect(() => CircuitBreaker({ failureThreshold: 0 })).toThrow(/failureThreshold/);
  });
});

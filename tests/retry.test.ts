import { describe, expect, test } from "bun:test";

import { CircuitOpenError } from "../src/decorators/circuitBreaker";
import { Retry, withRetry } from "../src/decorators/retry";

class ErroDeIntegracao extends Error {
  constructor(readonly tentativa: number) {
    super(`falha ${tentativa}`);
  }
}

/** Uma função que falha `falhas` vezes e depois devolve "ok". */
const buildInstavel = (falhas: number) => {
  let chamadas = 0;
  const fn = async () => {
    chamadas++;
    if (chamadas <= falhas) throw new ErroDeIntegracao(chamadas);
    return "ok";
  };
  return { fn, countChamadas: () => chamadas };
};

describe("withRetry", () => {
  test("sucesso na primeira tentativa não espera nem repete", async () => {
    const { fn, countChamadas } = buildInstavel(0);
    const esperas: number[] = [];

    const resultado = await withRetry(fn, { delayMs: 1, onRetry: (_e, _a, d) => esperas.push(d) });

    expect(resultado).toBe("ok");
    expect(countChamadas()).toBe(1);
    expect(esperas).toEqual([]);
  });

  test("tenta de novo até dar certo", async () => {
    const { fn, countChamadas } = buildInstavel(2);

    const resultado = await withRetry(fn, { attempts: 3, delayMs: 1, jitter: false });

    expect(resultado).toBe("ok");
    expect(countChamadas()).toBe(3);
  });

  test("esgota as tentativas e relança o ÚLTIMO erro, sem embrulhar", async () => {
    const { fn, countChamadas } = buildInstavel(10);

    const erro = await withRetry(fn, { attempts: 3, delayMs: 1, jitter: false }).catch((e) => e);

    expect(erro).toBeInstanceOf(ErroDeIntegracao);
    expect((erro as ErroDeIntegracao).tentativa).toBe(3);
    expect(countChamadas()).toBe(3);
  });

  test("retryIf falso para na hora", async () => {
    const { fn, countChamadas } = buildInstavel(10);
    const tentativasVistas: number[] = [];

    const erro = await withRetry(fn, {
      attempts: 5,
      delayMs: 1,
      retryIf: (_e, tentativa) => {
        tentativasVistas.push(tentativa);
        return tentativa < 2;
      },
    }).catch((e) => e);

    expect((erro as ErroDeIntegracao).tentativa).toBe(2);
    expect(countChamadas()).toBe(2);
    expect(tentativasVistas).toEqual([1, 2]);
  });

  test("CircuitOpenError não é repetido por padrão", async () => {
    let chamadas = 0;
    const fn = async () => {
      chamadas++;
      throw new CircuitOpenError("eSocial", 1000);
    };

    const erro = await withRetry(fn, { attempts: 4, delayMs: 1 }).catch((e) => e);

    expect(erro).toBeInstanceOf(CircuitOpenError);
    expect(chamadas).toBe(1);
  });

  test("espera exponencial com teto (sem sorteio)", async () => {
    const { fn } = buildInstavel(10);
    const chamadas: Array<[number, number]> = [];

    await withRetry(fn, {
      attempts: 5,
      delayMs: 2,
      factor: 3,
      maxDelayMs: 20,
      jitter: false,
      onRetry: (_e, tentativa, espera) => chamadas.push([tentativa, espera]),
    }).catch(() => undefined);

    expect(chamadas).toEqual([
      [1, 2],
      [2, 6],
      [3, 18],
      [4, 20],
    ]);
  });

  test("com sorteio a espera fica entre a metade e o valor cheio", async () => {
    const { fn } = buildInstavel(10);
    const esperas: number[] = [];

    await withRetry(fn, {
      attempts: 4,
      delayMs: 4,
      onRetry: (_e, _a, espera) => esperas.push(espera),
    }).catch(() => undefined);

    const cheias = [4, 8, 16];
    esperas.forEach((espera, indice) => {
      expect(espera).toBeGreaterThanOrEqual(cheias[indice] / 2);
      expect(espera).toBeLessThanOrEqual(cheias[indice]);
    });
    expect(esperas).toHaveLength(3);
  });

  test("onRetry recebe o erro da tentativa que falhou", async () => {
    const { fn } = buildInstavel(1);
    const erros: unknown[] = [];

    await withRetry(fn, { delayMs: 1, onRetry: (erro) => erros.push(erro) });

    expect(erros).toHaveLength(1);
    expect((erros[0] as ErroDeIntegracao).tentativa).toBe(1);
  });

  test("erro síncrono da função também é repetido", async () => {
    let chamadas = 0;
    const fn = () => {
      chamadas++;
      if (chamadas < 2) throw new Error("síncrono");
      return 42;
    };

    expect(await withRetry(fn, { delayMs: 1 })).toBe(42);
  });

  test.each([
    [{ attempts: 0 }, "attempts"],
    [{ attempts: 1.5 }, "attempts"],
    [{ delayMs: -1 }, "delayMs"],
    [{ factor: 0.5 }, "factor"],
    [{ maxDelayMs: Number.NaN }, "maxDelayMs"],
  ])("opção inválida %p rejeita citando %s", async (opcoes, campo) => {
    const erro = await withRetry(async () => 1, opcoes).catch((e) => e);
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toContain(campo);
  });
});

describe("@Retry", () => {
  test("repete o método e mantém o this", async () => {
    class ClienteEsocial {
      chamadas = 0;

      @Retry({ attempts: 3, delayMs: 1, jitter: false })
      async sendLote(lote: string) {
        this.chamadas++;
        if (this.chamadas < 3) throw new Error("fora do ar");
        return `${lote} enviado`;
      }
    }

    const cliente = new ClienteEsocial();
    expect(await cliente.sendLote("S-1200")).toBe("S-1200 enviado");
    expect(cliente.chamadas).toBe(3);
  });

  test("opção inválida lança ao decorar", () => {
    expect(() => Retry({ attempts: 0 })).toThrow(/attempts/);
  });
});

describe("withRetry segura o processo durante a espera", () => {
  test("a nova tentativa disparada sem await não é perdida quando o script termina", async () => {
    const script = `
      import { withRetry } from "${import.meta.dir}/../src/decorators/retry";
      let vez = 0;
      void withRetry(() => { if (++vez < 2) throw new Error("x"); return "ok"; }, { delayMs: 50, jitter: false })
        .then((valor) => console.log(valor));
    `;
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const saida = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(saida.trim()).toBe("ok");
  });
});

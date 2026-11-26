import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  Timed,
  clearTimings,
  getTimings,
  onTiming,
  type TimingSample,
} from "../src/decorators/timed";
import { captureErrors, captureWarnings, fakeMethodContext } from "./_helpers";

/** Faz cada chamada durar exatamente o que a lista diz: `performance.now()` devolve 0 e depois a duração. */
const useDuracoes = (duracoes: number[]) => {
  const leituras = duracoes.flatMap((duracao) => [0, duracao]);
  return spyOn(performance, "now").mockImplementation(() => leituras.shift() ?? 0);
};

const findTiming = (name: string) => getTimings().find((stats) => stats.name === name);

describe("@Timed", () => {
  let warnCap: ReturnType<typeof captureWarnings>;

  beforeEach(() => {
    clearTimings();
    warnCap = captureWarnings();
  });
  afterEach(() => {
    warnCap.restore();
  });

  test("registra a chamada assíncrona com o nome Classe.metodo", async () => {
    class ImovelService {
      @Timed()
      async findImovel(id: number) {
        return { id };
      }
    }

    expect(await new ImovelService().findImovel(7)).toEqual({ id: 7 });
    const stats = findTiming("ImovelService.findImovel");
    expect(stats?.count).toBe(1);
    expect(stats?.errors).toBe(0);
  });

  test("método síncrono continua síncrono e é medido na hora", () => {
    class Calculo {
      @Timed()
      calcularIptu(valor: number) {
        return valor * 2;
      }
    }

    const retorno = new Calculo().calcularIptu(21);
    expect(retorno).toBe(42);
    expect(retorno instanceof Promise).toBe(false);
    expect(findTiming("Calculo.calcularIptu")?.count).toBe(1);
  });

  test("erro síncrono é registrado e relançado sem mudança", () => {
    const erro = new Error("falhou");
    class Calculo {
      @Timed()
      calcularIptu() {
        throw erro;
      }
    }

    expect(() => new Calculo().calcularIptu()).toThrow(erro);
    expect(findTiming("Calculo.calcularIptu")).toMatchObject({ count: 1, errors: 1 });
  });

  test("rejeição é registrada e relançada sem mudança", async () => {
    const erro = new Error("falhou");
    class Remessa {
      @Timed()
      async sendLote() {
        throw erro;
      }
    }

    const amostras: TimingSample[] = [];
    const cancel = onTiming((amostra) => amostras.push(amostra));
    await expect(new Remessa().sendLote()).rejects.toBe(erro);
    cancel();
    expect(findTiming("Remessa.sendLote")).toMatchObject({ count: 1, errors: 1 });
    expect(amostras[0]?.ok).toBe(false);
  });

  test("name troca o nome da métrica", async () => {
    class Remessa {
      @Timed({ name: "remessa.envio" })
      async sendLote() {}
    }

    await new Remessa().sendLote();
    expect(findTiming("remessa.envio")?.count).toBe(1);
    expect(findTiming("Remessa.sendLote")).toBeUndefined();
  });

  test("soma, mínimo, máximo e percentis por posição mais próxima", () => {
    class Calculo {
      @Timed()
      calcularIptu() {}
    }

    const relogio = useDuracoes(Array.from({ length: 100 }, (_, i) => i + 1));
    const calculo = new Calculo();
    for (let i = 0; i < 100; i++) calculo.calcularIptu();
    relogio.mockRestore();

    expect(findTiming("Calculo.calcularIptu")).toEqual({
      name: "Calculo.calcularIptu",
      count: 100,
      errors: 0,
      totalMs: 5050,
      minMs: 1,
      maxMs: 100,
      p50Ms: 50,
      p95Ms: 95,
      p99Ms: 99,
    });
  });

  test("percentis olham só as últimas 1.000 chamadas", () => {
    class Calculo {
      @Timed()
      calcularIptu() {}
    }

    const relogio = useDuracoes([...Array(1000).fill(500), ...Array(1000).fill(1)]);
    const calculo = new Calculo();
    for (let i = 0; i < 2000; i++) calculo.calcularIptu();
    relogio.mockRestore();

    const stats = findTiming("Calculo.calcularIptu");
    expect(stats).toMatchObject({ count: 2000, maxMs: 500, minMs: 1, p99Ms: 1 });
  });

  test("slowMs avisa no log a chamada lenta", () => {
    class Calculo {
      @Timed({ slowMs: 100 })
      calcularIptu() {}
    }

    const relogio = useDuracoes([50, 250]);
    const calculo = new Calculo();
    calculo.calcularIptu();
    expect(warnCap.warnings.some((w) => w.includes("Calculo.calcularIptu"))).toBe(false);
    calculo.calcularIptu();
    relogio.mockRestore();

    expect(warnCap.warnings.filter((w) => w.includes("Calculo.calcularIptu"))).toHaveLength(1);
  });

  test("onTiming recebe cada amostra até cancelar", async () => {
    class Calculo {
      @Timed()
      async calcularIptu() {}
    }

    const amostras: TimingSample[] = [];
    const cancel = onTiming((amostra) => amostras.push(amostra));
    await new Calculo().calcularIptu();
    cancel();
    await new Calculo().calcularIptu();

    expect(amostras).toHaveLength(1);
    expect(amostras[0]).toMatchObject({ name: "Calculo.calcularIptu", ok: true });
    expect(typeof amostras[0]?.durationMs).toBe("number");
  });

  test("ouvinte que lança não quebra a chamada e vai para o log", () => {
    const { errors: erros, restore } = captureErrors();

    class Calculo {
      @Timed()
      calcularIptu() {
        return 1;
      }
    }

    const cancel = onTiming(() => {
      throw new Error("exportador fora");
    });
    try {
      expect(new Calculo().calcularIptu()).toBe(1);
    } finally {
      cancel();
      restore();
    }
    expect(erros.some((e) => e.includes("exportador fora"))).toBe(true);
  });

  test("getTimings devolve as métricas em ordem de nome", () => {
    class Zeta {
      @Timed()
      run() {}
    }
    class Alfa {
      @Timed()
      run() {}
    }

    new Zeta().run();
    new Alfa().run();
    expect(getTimings().map((stats) => stats.name)).toEqual(["Alfa.run", "Zeta.run"]);
  });

  test("clearTimings zera as estatísticas e mantém os ouvintes", () => {
    class Calculo {
      @Timed()
      calcularIptu() {}
    }

    const amostras: TimingSample[] = [];
    const cancel = onTiming((amostra) => amostras.push(amostra));
    new Calculo().calcularIptu();
    clearTimings();
    expect(getTimings()).toEqual([]);
    new Calculo().calcularIptu();
    cancel();

    expect(amostras).toHaveLength(2);
    expect(findTiming("Calculo.calcularIptu")?.count).toBe(1);
  });

  test("TC39: envolve o método recebido com o contexto", () => {
    class Calculo {}
    const calcularIptu = () => 3;

    const envolvido = Timed()(calcularIptu, fakeMethodContext("calcularIptu"));
    expect(envolvido.call(new Calculo())).toBe(3);
    expect(findTiming("Calculo.calcularIptu")?.count).toBe(1);
  });
});

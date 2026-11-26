import { afterEach, describe, expect, test } from "bun:test";

import { AfterCommit } from "../src/decorators/afterCommit";
import { TransactionalClass } from "../src/decorators/transactional";
import { eventBus } from "../src/events/eventBus";
import { afterCommit } from "../src/handlers/afterCommit";
import { setHandlerContext } from "../src/handlers/context";
import { runInTransaction } from "../src/handlers/prisma";
import { captureWarnings } from "./_helpers";

/** Transação do Prisma 7 que registra os comandos (SAVEPOINT etc.). */
const fakeTx7 = () => {
  const sqls: string[] = [];
  return { sqls, $executeRawUnsafe: async (sql: string) => (sqls.push(sql), 1) };
};

/** Client do Prisma 7: o `$transaction` só resolve depois de "comitar". */
const client7 = (tx = fakeTx7()) => ({ $transaction: async (fn: (t: any) => any) => fn(tx) });

/** Client cujo commit falha depois de a função terminar bem. */
const failingCommit = () => ({
  $transaction: async (fn: (t: any) => any) => {
    await fn(fakeTx7());
    throw new Error("commit falhou");
  },
});

const client8 = () => {
  const tx = { orm: {}, execute: async () => ({ affectedRows: 0 }), query: async () => [] };
  return { transaction: async (fn: (t: any) => any) => fn(tx) };
};

afterEach(() => {
  setHandlerContext(() => undefined);
  eventBus.removeAllListeners();
});

describe("afterCommit", () => {
  test("só roda depois do commit, na ordem em que entrou", async () => {
    const ordem: string[] = [];
    await runInTransaction(client7(), async (tx) => {
      afterCommit(tx, () => void ordem.push("primeiro"));
      afterCommit(tx, async () => void ordem.push("segundo"));
      ordem.push("fim da transação");
    });
    expect(ordem).toEqual(["fim da transação", "primeiro", "segundo"]);
  });

  test("rollback descarta", async () => {
    let ran = false;
    const call = runInTransaction(client7(), async (tx) => {
      afterCommit(tx, () => void (ran = true));
      throw new Error("deu ruim");
    });
    await expect(call).rejects.toThrow("deu ruim");
    expect(ran).toBe(false);
  });

  test("commit que falha também descarta", async () => {
    let ran = false;
    await expect(
      runInTransaction(failingCommit(), async (tx) => afterCommit(tx, () => void (ran = true))),
    ).rejects.toThrow("commit falhou");
    expect(ran).toBe(false);
  });

  test("vale no Prisma 8", async () => {
    let ran = false;
    await runInTransaction(client8(), async (tx) => afterCommit(tx, () => void (ran = true)));
    expect(ran).toBe(true);
  });

  test("erro num gancho não desfaz o commit nem impede os outros", async () => {
    const ordem: string[] = [];
    const result = await runInTransaction(client7(), async (tx) => {
      afterCommit(tx, () => {
        throw new Error("gancho quebrou");
      });
      afterCommit(tx, () => void ordem.push("segundo"));
      return "resultado";
    });
    expect(result).toBe("resultado");
    expect(ordem).toEqual(["segundo"]);
  });

  test("sem transação roda na hora", () => {
    let ran = false;
    afterCommit(undefined, () => void (ran = true));
    expect(ran).toBe(true);
  });

  test("transação que o pacote não abriu roda na hora e avisa", () => {
    const { warnings, restore } = captureWarnings();
    let ran = false;
    try {
      afterCommit(fakeTx7(), () => void (ran = true));
    } finally {
      restore();
    }
    expect(ran).toBe(true);
    expect(warnings.join("\n")).toContain("runInTransaction");
  });

  test("gancho registrado depois do commit roda na hora", async () => {
    let saved: unknown;
    await runInTransaction(client7(), async (tx) => void (saved = tx));
    let ran = false;
    afterCommit(saved, () => void (ran = true));
    expect(ran).toBe(true);
  });
});

describe("@AfterCommit", () => {
  class ParcelaService {
    constructor(readonly DAO: { tx?: unknown } = {}) {}

    @AfterCommit("parcela.quitada")
    async quitar(id: string) {
      return { id };
    }
  }

  const listen = () => {
    const recebidos: any[] = [];
    eventBus.on("parcela.quitada", (payload) => void recebidos.push(payload));
    return recebidos;
  };

  test("publica depois do commit, com o mesmo payload do @Emit", async () => {
    const recebidos = listen();
    let duranteATransacao = -1;
    await runInTransaction(client7(), async (tx) => {
      const service = new ParcelaService({ tx });
      await service.quitar("p1");
      duranteATransacao = recebidos.length;
    });
    expect(duranteATransacao).toBe(0);
    expect(recebidos).toHaveLength(1);
    expect(recebidos[0].result).toEqual({ id: "p1" });
    expect(recebidos[0].args).toEqual(["p1"]);
    expect(recebidos[0].instance).toBeInstanceOf(ParcelaService);
  });

  test("rollback: o evento nunca sai", async () => {
    const recebidos = listen();
    await expect(
      runInTransaction(client7(), async (tx) => {
        await new ParcelaService({ tx }).quitar("p1");
        throw new Error("baixa falhou");
      }),
    ).rejects.toThrow("baixa falhou");
    expect(recebidos).toHaveLength(0);
  });

  test("acha a transação no contexto do handler", async () => {
    const recebidos = listen();
    await runInTransaction(client7(), async (tx) => {
      setHandlerContext(() => ({ transaction: tx }));
      await new ParcelaService().quitar("p2");
      expect(recebidos).toHaveLength(0);
    });
    expect(recebidos).toHaveLength(1);
  });

  test("método que lança não publica", async () => {
    const recebidos = listen();
    class Falha {
      @AfterCommit("parcela.quitada")
      async quitar() {
        throw new Error("não quitou");
      }
    }
    await runInTransaction(client7(), async () => {
      await expect(new Falha().quitar()).rejects.toThrow("não quitou");
    });
    expect(recebidos).toHaveLength(0);
  });

  test("sem transação publica na hora", async () => {
    const recebidos = listen();
    await new ParcelaService().quitar("p3");
    expect(recebidos).toHaveLength(1);
  });
});

describe("savepoint do @TransactionalClass", () => {
  test("a escrita revertida pelo savepoint leva os ganchos dela junto", async () => {
    const ordem: string[] = [];

    @TransactionalClass
    class ImovelController {
      constructor(readonly DAO: { tx: unknown }) {}

      async create(nome: string) {
        afterCommit(this.DAO.tx, () => void ordem.push(`criou ${nome}`));
        if (nome === "ruim") throw new Error("não criou");
      }
    }

    await runInTransaction(client7(), async (tx) => {
      const controller = new ImovelController({ tx });
      await controller.create("bom");
      await controller.create("ruim").catch(() => undefined);
      await controller.create("outro");
    });
    expect(ordem).toEqual(["criou bom", "criou outro"]);
  });
});

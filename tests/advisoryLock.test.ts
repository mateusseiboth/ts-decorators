import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  AdvisoryLock,
  AdvisoryLockTimeoutError,
  configureAdvisoryLock,
  withAdvisoryLock,
} from "../src/decorators/advisoryLock";
import { setHandlerContext } from "../src/handlers/context";
import { configurePrisma8, resetPrisma8 } from "../src/prisma8/client";
import { fakeCombinators, fakeDb8, fakeTx8 } from "../src/testing/prisma8Fakes";

/** Transação do Prisma 7 que registra os comandos e responde o GET_LOCK do MySQL. */
function fakeTx7(getLock: unknown = 1n) {
  const sqls: string[] = [];
  return {
    sqls,
    async $executeRawUnsafe(sql: string) {
      sqls.push(sql);
      return 1;
    },
    async $queryRawUnsafe(sql: string) {
      sqls.push(sql);
      return sql.includes("GET_LOCK") ? [{ travou: getLock }] : [{ liberou: 1n }];
    },
  };
}

const RE_PG_LOCK = /^SELECT pg_advisory_xact_lock\((-?\d+)\)$/;

beforeEach(() => configureAdvisoryLock({ dialect: "postgres" }));
afterEach(() => setHandlerContext(() => undefined));

describe("withAdvisoryLock no Postgres", () => {
  test("trava pela transação com pg_advisory_xact_lock e devolve o resultado", async () => {
    const tx = fakeTx7();
    const result = await withAdvisoryLock(tx, "remessa:001", () => "feito");
    expect(result).toBe("feito");
    expect(tx.sqls).toHaveLength(1);
    expect(tx.sqls[0]).toMatch(RE_PG_LOCK);
  });

  test("a mesma chave dá o mesmo número; chaves diferentes, números diferentes", async () => {
    const tx = fakeTx7();
    await withAdvisoryLock(tx, "remessa:001", () => undefined);
    await withAdvisoryLock(tx, "remessa:001", () => undefined);
    await withAdvisoryLock(tx, "remessa:002", () => undefined);
    const [a, b, c] = tx.sqls.map((sql) => RE_PG_LOCK.exec(sql)?.[1]);
    expect(a).toBe(b!);
    expect(a).not.toBe(c!);
  });

  test("a chave nunca entra no SQL: só o número dela", async () => {
    const tx = fakeTx7();
    await withAdvisoryLock(tx, "x'); DROP TABLE contribuinte; --", () => undefined);
    expect(tx.sqls[0]).toMatch(RE_PG_LOCK);
  });

  test("o número cabe num bigint do Postgres", async () => {
    const tx = fakeTx7();
    for (const key of ["a", "imovel:42", "ç", "x".repeat(500)]) {
      await withAdvisoryLock(tx, key, () => undefined);
    }
    for (const sql of tx.sqls) {
      const value = BigInt(RE_PG_LOCK.exec(sql)![1]!);
      expect(value >= -(2n ** 63n) && value < 2n ** 63n).toBe(true);
    }
  });

  test("waitMs vira lock_timeout local, desfeito depois da trava", async () => {
    const tx = fakeTx7();
    await withAdvisoryLock(tx, "k", () => undefined, { waitMs: 1500 });
    expect(tx.sqls[0]).toBe("SET LOCAL lock_timeout = '1500ms'");
    expect(tx.sqls[1]).toMatch(RE_PG_LOCK);
    expect(tx.sqls[2]).toBe("SET LOCAL lock_timeout TO DEFAULT");
  });

  test("estourar o lock_timeout vira AdvisoryLockTimeoutError e não roda a função", async () => {
    const tx = {
      async $executeRawUnsafe(sql: string) {
        if (sql.startsWith("SELECT")) throw new Error("canceling statement due to lock timeout");
        return 0;
      },
    };
    let ran = false;
    const call = withAdvisoryLock(tx, "k", () => (ran = true), { waitMs: 10 });
    await expect(call).rejects.toBeInstanceOf(AdvisoryLockTimeoutError);
    await expect(call).rejects.toMatchObject({ key: "k", waitMs: 10 });
    expect(ran).toBe(false);
  });

  test("outro erro do banco passa como veio", async () => {
    const tx = {
      async $executeRawUnsafe() {
        throw new Error("connection reset");
      },
    };
    await expect(withAdvisoryLock(tx, "k", () => undefined)).rejects.toThrow("connection reset");
  });

  test("funciona na transação do Prisma 8", async () => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
    const tx = fakeTx8({});
    await withAdvisoryLock(tx, "k", () => undefined);
    expect(tx.statements[0]).toMatch(RE_PG_LOCK);
    resetPrisma8();
  });
});

describe("withAdvisoryLock no MySQL", () => {
  test("GET_LOCK com nome seguro, função e RELEASE_LOCK no fim", async () => {
    const tx = fakeTx7(1n);
    const result = await withAdvisoryLock(tx, "remessa:'001'", () => "ok", { dialect: "mysql" });
    expect(result).toBe("ok");
    const [lock, release] = tx.sqls;
    expect(lock).toMatch(/^SELECT GET_LOCK\('qs_[0-9a-f]{16}', -1\) AS travou$/);
    const name = /'(qs_[0-9a-f]{16})'/.exec(lock!)![1];
    expect(release).toBe(`SELECT RELEASE_LOCK('${name}') AS liberou`);
  });

  test("waitMs vira segundos, arredondando para cima", async () => {
    const tx = fakeTx7(1);
    await withAdvisoryLock(tx, "k", () => undefined, { dialect: "mysql", waitMs: 1500 });
    expect(tx.sqls[0]).toMatch(/, 2\) AS travou$/);
  });

  test("libera mesmo quando a função lança", async () => {
    const tx = fakeTx7(1n);
    const call = withAdvisoryLock(
      tx,
      "k",
      () => {
        throw new Error("falhou");
      },
      { dialect: "mysql" },
    );
    await expect(call).rejects.toThrow("falhou");
    expect(tx.sqls[1]).toContain("RELEASE_LOCK");
  });

  test("GET_LOCK 0 (tempo esgotado) vira AdvisoryLockTimeoutError, sem função e sem liberar", async () => {
    const tx = fakeTx7(0n);
    let ran = false;
    const call = withAdvisoryLock(tx, "k", () => (ran = true), { dialect: "mysql", waitMs: 100 });
    await expect(call).rejects.toBeInstanceOf(AdvisoryLockTimeoutError);
    expect(ran).toBe(false);
    expect(tx.sqls).toHaveLength(1);
  });

  test("GET_LOCK nulo (erro no banco) falha explicando", async () => {
    const tx = fakeTx7(null);
    await expect(withAdvisoryLock(tx, "k", () => undefined, { dialect: "mysql" })).rejects.toThrow(
      /GET_LOCK/,
    );
  });

  test("MySQL exige transação do Prisma 7", async () => {
    resetPrisma8();
    configurePrisma8({ db: fakeDb8(), ...fakeCombinators });
    await expect(
      withAdvisoryLock(fakeTx8({}), "k", () => undefined, { dialect: "mysql" }),
    ).rejects.toThrow(/Prisma 7/);
    resetPrisma8();
  });

  test("configureAdvisoryLock troca o dialeto padrão", async () => {
    configureAdvisoryLock({ dialect: "mysql" });
    const tx = fakeTx7(1n);
    await withAdvisoryLock(tx, "k", () => undefined);
    expect(tx.sqls[0]).toContain("GET_LOCK");
  });
});

describe("withAdvisoryLock sem transação", () => {
  test("falha alto: a trava sem transação seria solta na hora", async () => {
    await expect(withAdvisoryLock(undefined, "k", () => undefined)).rejects.toThrow(/transação/);
    await expect(withAdvisoryLock({}, "k", () => undefined)).rejects.toThrow(/transação/);
  });

  test("chave vazia é erro", async () => {
    await expect(withAdvisoryLock(fakeTx7(), " ", () => undefined)).rejects.toThrow(/chave/);
  });
});

describe("@AdvisoryLock", () => {
  test("chave pelos argumentos e transação do DAO", async () => {
    const tx = fakeTx7();
    class RemessaService {
      DAO = { tx };
      @AdvisoryLock({ key: (banco: string) => `remessa:${banco}` })
      async gerar(banco: string) {
        return `remessa ${banco}`;
      }
    }
    const direct = fakeTx7();
    await withAdvisoryLock(direct, "remessa:001", () => undefined);
    expect(await new RemessaService().gerar("001")).toBe("remessa 001");
    expect(tx.sqls).toEqual(direct.sqls);
  });

  test("a transação do contexto do handler vem antes da do DAO", async () => {
    const fromContext = fakeTx7();
    const fromDao = fakeTx7();
    setHandlerContext(() => ({ transaction: fromContext }));
    class Service {
      DAO = { tx: fromDao };
      @AdvisoryLock({ key: "fixa" })
      async run() {}
    }
    await new Service().run();
    expect(fromContext.sqls).toHaveLength(1);
    expect(fromDao.sqls).toHaveLength(0);
  });

  test("this.tx e a opção tx também servem", async () => {
    const own = fakeTx7();
    const custom = fakeTx7();
    class Service {
      tx = own;
      outra = custom;
      @AdvisoryLock({ key: "a" })
      async byField() {}
      @AdvisoryLock({ key: "b", tx: (instance: Service) => instance.outra })
      async byOption() {}
    }
    await new Service().byField();
    await new Service().byOption();
    expect(own.sqls).toHaveLength(1);
    expect(custom.sqls).toHaveLength(1);
  });

  test("sem transação nenhuma, o método não roda", async () => {
    let ran = false;
    class Service {
      @AdvisoryLock({ key: "k" })
      async run() {
        ran = true;
      }
    }
    await expect(new Service().run()).rejects.toThrow(/transação/);
    expect(ran).toBe(false);
  });

  test("opção de dialeto no decorator vence o padrão", async () => {
    const tx = fakeTx7(1n);
    class Service {
      DAO = { tx };
      @AdvisoryLock({ key: "k", dialect: "mysql" })
      async run() {}
    }
    await new Service().run();
    expect(tx.sqls[0]).toContain("GET_LOCK");
  });
});

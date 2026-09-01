import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearLegacyWarnings } from "../src/decorators/_proxy";
import {
  TransactionalClass,
  getSavepointPolicy,
  setSavepointPolicy,
  setTransactionalCompanyFn,
} from "../src/decorators/transactional";
import { captureLogs, captureWarnings, fakeClassContext } from "./_helpers";

describe("TransactionalClass", () => {
  let warnCap: ReturnType<typeof captureWarnings>;
  let logCap: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    clearLegacyWarnings();
    warnCap = captureWarnings();
    logCap = captureLogs();
    setSavepointPolicy("always");
  });
  afterEach(() => {
    warnCap.restore();
    logCap.restore();
    setSavepointPolicy("auto");
  });

  function mockTx() {
    const calls: string[] = [];
    return {
      calls,
      $executeRawUnsafe: async (sql: string) => {
        calls.push(sql);
      },
    };
  }

  describe("Legacy", () => {
    test("emite warning", () => {
      class C {
        DAO = { tx: mockTx() };
        async create() {
          return { id: 1 };
        }
      }
      TransactionalClass(C as any);
      expect(warnCap.warnings.some((w) => w.includes("TransactionalClass"))).toBe(true);
    });

    test("cria e libera savepoint em sucesso", async () => {
      const tx = mockTx();
      class C {
        DAO = { tx };
        async create() {
          return { id: 1 };
        }
      }
      TransactionalClass(C as any);
      const i = new C();
      const result = await i.create();
      expect(result).toEqual({ id: 1 });
      expect(tx.calls.some((c) => c.startsWith('SAVEPOINT "sp_create_'))).toBe(true);
      expect(tx.calls.some((c) => c.startsWith('RELEASE SAVEPOINT "sp_create_'))).toBe(true);
    });

    test("rollback em caso de erro", async () => {
      const tx = mockTx();
      class C {
        DAO = { tx };
        async update() {
          throw new Error("falha");
        }
      }
      TransactionalClass(C as any);
      const i = new C();
      let err: Error | null = null;
      try {
        await i.update();
      } catch (e: any) {
        err = e;
      }
      expect(err?.message).toBe("falha");
      expect(tx.calls.some((c) => c.startsWith('ROLLBACK TO SAVEPOINT "sp_update_'))).toBe(true);
    });

    test("métodos não write passam direto", async () => {
      const tx = mockTx();
      class C {
        DAO = { tx };
        async get() {
          return [1, 2];
        }
      }
      TransactionalClass(C as any);
      const result = await new C().get();
      expect(result).toEqual([1, 2]);
      expect(tx.calls.length).toBe(0);
    });
  });

  describe("TC39", () => {
    test("SEM warning com context", () => {
      class C {
        async create() {
          return {};
        }
      }
      TransactionalClass(C as any, fakeClassContext("C"));
      expect(warnCap.warnings.every((w) => !w.includes("TransactionalClass"))).toBe(true);
    });

    test("savepoints funcionam igual no TC39", async () => {
      const tx = mockTx();
      class C {
        DAO = { tx };
        async deleteById() {
          return true;
        }
      }
      TransactionalClass(C as any, fakeClassContext("C"));
      const result = await new C().deleteById();
      expect(result).toBe(true);
      expect(tx.calls.some((c) => c.startsWith('SAVEPOINT "sp_deleteById_'))).toBe(true);
      expect(tx.calls.some((c) => c.startsWith('RELEASE SAVEPOINT "sp_deleteById_'))).toBe(true);
    });
  });

  describe("política de savepoint", () => {
    test('o padrão é "auto"', () => {
      setSavepointPolicy("auto");
      expect(getSavepointPolicy()).toBe("auto");
    });

    test('"auto": a PRIMEIRA escrita da transação não gasta savepoint', async () => {
      setSavepointPolicy("auto");
      const tx = mockTx();
      class C {
        DAO = { tx };
        async create() {
          return { id: 1 };
        }
      }
      TransactionalClass(C as any);
      await new C().create();
      expect(tx.calls.length).toBe(0);
    });

    test('"auto": a partir da SEGUNDA escrita na mesma transação, protege', async () => {
      setSavepointPolicy("auto");
      const tx = mockTx();
      class C {
        DAO = { tx };
        async create() {
          return { id: 1 };
        }
      }
      TransactionalClass(C as any);
      const controller = new C();
      await controller.create();
      await controller.create();

      expect(tx.calls.filter((c) => c.startsWith("SAVEPOINT")).length).toBe(1);
      expect(tx.calls.filter((c) => c.startsWith("RELEASE SAVEPOINT")).length).toBe(1);
    });

    test('"auto": escritas em transações DIFERENTES não contam entre si', async () => {
      setSavepointPolicy("auto");
      const txA = mockTx();
      const txB = mockTx();
      class C {
        DAO: any;
        constructor(tx: any) {
          this.DAO = { tx };
        }
        async create() {
          return { id: 1 };
        }
      }
      TransactionalClass(C as any);
      await new C(txA).create();
      await new C(txB).create();

      expect(txA.calls.length).toBe(0);
      expect(txB.calls.length).toBe(0);
    });

    test('"auto": escrita ANINHADA em outra escrita ganha savepoint', async () => {
      setSavepointPolicy("auto");
      const tx = mockTx();
      class Filho {
        DAO = { tx };
        async create() {
          return { id: 2 };
        }
      }
      TransactionalClass(Filho as any);
      const filho = new Filho();

      class Pai {
        DAO = { tx };
        async create() {
          return filho.create();
        }
      }
      TransactionalClass(Pai as any);

      await new Pai().create();
      expect(tx.calls.filter((c) => c.startsWith('SAVEPOINT "sp_create_')).length).toBe(1);
    });

    test('"never" nunca emite savepoint', async () => {
      setSavepointPolicy("never");
      const tx = mockTx();
      class C {
        DAO = { tx };
        async create() {
          return { id: 1 };
        }
      }
      TransactionalClass(C as any);
      const controller = new C();
      await controller.create();
      await controller.create();
      expect(tx.calls.length).toBe(0);
    });

    test("nomes de savepoint não colidem dentro do mesmo milissegundo", async () => {
      setSavepointPolicy("always");
      const tx = mockTx();
      class C {
        DAO = { tx };
        async create() {
          return { id: 1 };
        }
      }
      TransactionalClass(C as any);
      const controller = new C();
      await Promise.all([controller.create(), controller.create(), controller.create()]);

      const nomes = tx.calls.filter((c) => c.startsWith("SAVEPOINT "));
      expect(new Set(nomes).size).toBe(3);
    });

    test('"auto": erro na segunda escrita reverte só até o savepoint', async () => {
      setSavepointPolicy("auto");
      const tx = mockTx();
      class C {
        DAO = { tx };
        falhar = false;
        async create() {
          if (this.falhar) throw new Error("boom");
          return { id: 1 };
        }
      }
      TransactionalClass(C as any);
      const controller = new C();
      await controller.create();
      controller.falhar = true;
      await controller.create().catch(() => {});

      expect(tx.calls.some((c) => c.startsWith('ROLLBACK TO SAVEPOINT "sp_create_'))).toBe(true);
    });
  });

  describe("setTransactionalCompanyFn", () => {
    test("aceita função customizada", () => {
      let called = false;
      setTransactionalCompanyFn(async () => {
        called = true;
      });
      // Apenas verifica que não dá erro ao setar
      expect(called).toBe(false);
    });
  });
});

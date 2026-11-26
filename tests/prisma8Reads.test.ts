import { describe, expect, test } from "bun:test";

import { prepareRead, readShared, shareReads } from "../src/prisma8/reads";

/**
 * As duas formas de não repetir trabalho numa leitura do Prisma 8:
 * - `prepareRead`: a consulta de forma fixa é compilada uma vez por processo e executada na
 *   transação de cada chamada;
 * - `shareReads`/`readShared`: numa unidade de trabalho só de leitura, a mesma leitura vai ao banco
 *   uma vez.
 */
const TX_A = { nome: "a" };
const TX_B = { nome: "b" };

type Tx = typeof TX_A;

function buildPrepare() {
  const chamadas = { prepare: 0, consultas: [] as { tx: Tx; params: { id: string } }[] };
  const prepare = () => {
    chamadas.prepare += 1;
    return Promise.resolve({
      query: (tx: Tx, params: { id: string }) => {
        chamadas.consultas.push({ tx, params });
        return Promise.resolve([{ id: params.id }]);
      },
    });
  };
  return { chamadas, prepare };
}

const failureOf = (promessa: Promise<unknown>) =>
  promessa.then(
    () => null,
    (err: unknown) => err,
  );

describe("prepareRead", () => {
  test("nada é preparado até a primeira leitura", () => {
    const { chamadas, prepare } = buildPrepare();

    prepareRead(prepare);

    expect(chamadas.prepare).toBe(0);
  });

  test("prepara uma vez e executa cada leitura na transação e com os parâmetros dela", async () => {
    const { chamadas, prepare } = buildPrepare();
    const readById = prepareRead(prepare);

    expect(await readById(TX_A, { id: "1" })).toEqual([{ id: "1" }]);
    expect(await readById(TX_B, { id: "2" })).toEqual([{ id: "2" }]);

    expect(chamadas.prepare).toBe(1);
    expect(chamadas.consultas).toEqual([
      { tx: TX_A, params: { id: "1" } },
      { tx: TX_B, params: { id: "2" } },
    ]);
  });

  test("leituras simultâneas antes de a preparação terminar preparam uma vez só", async () => {
    const { chamadas, prepare } = buildPrepare();
    const readById = prepareRead(prepare);

    await Promise.all([readById(TX_A, { id: "1" }), readById(TX_B, { id: "2" })]);

    expect(chamadas.prepare).toBe(1);
  });

  test("a preparação que falha é tentada de novo na leitura seguinte", async () => {
    const { prepare } = buildPrepare();
    let tentativas = 0;
    const readById = prepareRead(() => {
      tentativas += 1;
      return tentativas === 1 ? Promise.reject(new Error("banco fora do ar")) : prepare();
    });

    expect(await failureOf(readById(TX_A, { id: "1" }))).toEqual(new Error("banco fora do ar"));
    expect(await readById(TX_A, { id: "1" })).toEqual([{ id: "1" }]);
  });
});

function buildLeitura() {
  const chamadas = { total: 0 };
  const ler = () => {
    chamadas.total += 1;
    return Promise.resolve(chamadas.total);
  };
  return { chamadas, ler };
}

describe("readShared", () => {
  test("fora do compartilhamento, cada chamada lê de novo", async () => {
    const { chamadas, ler } = buildLeitura();

    const lidas = [await readShared(TX_A, "x", ler), await readShared(TX_A, "x", ler)];

    expect(lidas).toEqual([1, 2]);
    expect(chamadas.total).toBe(2);
  });

  test("no compartilhamento, a mesma chave lê uma vez, até em chamadas simultâneas", async () => {
    const { chamadas, ler } = buildLeitura();

    const lidas = await shareReads(TX_A, async () => [
      ...(await Promise.all([readShared(TX_A, "x", ler), readShared(TX_A, "x", ler)])),
      await readShared(TX_A, "x", ler),
    ]);

    expect(lidas).toEqual([1, 1, 1]);
    expect(chamadas.total).toBe(1);
  });

  test("chaves diferentes e transações diferentes não se misturam", async () => {
    const { chamadas, ler } = buildLeitura();

    const lidas = await shareReads(TX_A, async () => [
      await readShared(TX_A, "x", ler),
      await readShared(TX_A, "y", ler),
      await readShared(TX_B, "x", ler),
      await readShared(TX_B, "x", ler),
    ]);

    expect(lidas).toEqual([1, 2, 3, 4]);
    expect(chamadas.total).toBe(4);
  });

  test("o compartilhamento de dentro não apaga o de fora", async () => {
    const { chamadas, ler } = buildLeitura();

    const lidas = await shareReads(TX_A, async () => {
      const antes = await readShared(TX_A, "x", ler);
      const dentro = await shareReads(TX_A, () => readShared(TX_A, "x", ler));
      return [antes, dentro, await readShared(TX_A, "x", ler)];
    });

    expect(lidas).toEqual([1, 1, 1]);
    expect(chamadas.total).toBe(1);
  });

  test("o compartilhamento acaba com a unidade, mesmo quando ela falha", async () => {
    const { chamadas, ler } = buildLeitura();
    const falha = new Error("regra");

    const erro = await failureOf(
      shareReads(TX_A, async () => {
        await readShared(TX_A, "x", ler);
        throw falha;
      }),
    );
    await readShared(TX_A, "x", ler);
    await readShared(TX_A, "x", ler);

    expect(erro).toBe(falha);
    expect(chamadas.total).toBe(3);
  });
});

/**
 * Duas formas de não repetir trabalho numa leitura do Prisma 8.
 *
 * - `prepareRead`: o Prisma 8 compila cada consulta do ORM a cada chamada (monta a árvore, coleta
 *   os parâmetros, renderiza o SQL). A leitura de forma fixa e muito chamada (a sessão conferida
 *   em toda requisição) pode ser preparada com `db.prepare`: o SQL é montado uma vez por processo,
 *   e cada chamada só liga os parâmetros. Roda na transação de cada chamada, então a RLS vale igual.
 * - `shareReads`/`readShared`: regras diferentes de uma mesma consulta pedem a mesma leitura. Dentro
 *   de `shareReads`, a leitura de mesma chave vai ao banco uma vez. Fora dele nada é guardado: a
 *   unidade que grava lê sempre o estado atual.
 */

/** O que o `db.prepare` do Prisma 8 devolve, no que a leitura usa. */
export interface PreparedQuery<Tx, Params, Row> {
  query(tx: Tx, params: Params): PromiseLike<Row[]>;
}

/**
 * A leitura preparada por `prepare` na primeira chamada (criar a leitura não toca o banco) e
 * executada na transação de cada chamada. A preparação que falha não fica guardada: a leitura
 * seguinte tenta de novo.
 */
export function prepareRead<Tx, Params, Row>(
  prepare: () => Promise<PreparedQuery<Tx, Params, Row>>,
): (tx: Tx, params: Params) => Promise<Row[]> {
  let preparada: Promise<PreparedQuery<Tx, Params, Row>> | undefined;
  const prepareOnce = (): Promise<PreparedQuery<Tx, Params, Row>> => {
    const nova = prepare().catch((err: unknown) => {
      if (preparada === nova) preparada = undefined;
      throw err;
    });
    return nova;
  };

  return async (tx, params) => {
    preparada ??= prepareOnce();
    return await (await preparada).query(tx, params);
  };
}

const LEITURAS = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * Roda `fn` com as leituras de `tx` compartilhadas; `fn` não pode gravar. Dentro de outro
 * `shareReads` da mesma transação, segue no compartilhamento de fora.
 */
export function shareReads<T>(tx: object, fn: () => Promise<T>): Promise<T> {
  if (LEITURAS.has(tx)) return fn();
  LEITURAS.set(tx, new Map());
  return fn().finally(() => LEITURAS.delete(tx));
}

/**
 * A leitura de `chave`: a já feita nesta transação, se ela compartilha leituras, ou uma nova. A
 * `chave` nomeia a leitura inteira (tabela, filtro, projeção e ordem): duas leituras diferentes
 * nunca usam a mesma.
 */
export function readShared<T>(tx: object, chave: string, ler: () => Promise<T>): Promise<T> {
  const leituras = LEITURAS.get(tx);
  if (!leituras) return ler();
  const feita = leituras.get(chave) as Promise<T> | undefined;
  if (feita) return feita;
  const nova = ler();
  leituras.set(chave, nova);
  return nova;
}

/**
 * Injeção do cliente Prisma.
 *
 * O client é gerado dentro do projeto (Prisma 7: `@prisma-generated/client`; Prisma 8: a
 * fachada `postgres<Contract>(...)`), portanto o pacote não pode importá-lo. Chame
 * `setPrismaClient` uma vez no bootstrap da aplicação antes de usar `Transactional` ou
 * `withTransaction`. Os dois clients servem: quem tem `$transaction` é o 7, quem tem
 * `transaction` é o 8.
 *
 * ```ts
 * import prismaClient from "@database/prisma";      // ou `db` de "@database/db"
 * import { setPrismaClient } from "@mateusseiboth/ts-decorators";
 * setPrismaClient(prismaClient);
 * ```
 */

export interface TransactionRunOptions {
  timeout?: number;
  /** ReadUncommitted | ReadCommitted | RepeatableRead | Snapshot | Serializable */
  isolationLevel?: string;
  maxWait?: number;
}

export interface Prisma7ClientLike {
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: TransactionRunOptions): Promise<T>;
}

export interface Prisma8ClientLike {
  transaction<T>(fn: (tx: any) => PromiseLike<T>): Promise<T>;
}

export type PrismaClientLike = Prisma7ClientLike | Prisma8ClientLike;

let _prismaClient: PrismaClientLike | null = null;

export function setPrismaClient(client: PrismaClientLike): void {
  _prismaClient = client;
}

export function getPrismaClient(): PrismaClientLike {
  if (!_prismaClient) {
    throw new Error(
      "[@mateusseiboth/ts-decorators] Prisma client não configurado. Chame setPrismaClient() no bootstrap da aplicação antes de usar Transactional/withTransaction.",
    );
  }
  return _prismaClient;
}

function isPrisma7Client(client: PrismaClientLike): client is Prisma7ClientLike {
  return typeof (client as Prisma7ClientLike).$transaction === "function";
}

/**
 * Abre a transação no client que estiver registrado. As opções (timeout, isolamento,
 * maxWait) só existem no Prisma 7; o `db.transaction` do 8 recebe apenas o callback.
 */
export function runInTransaction<T>(
  client: PrismaClientLike,
  fn: (tx: any) => Promise<T>,
  options?: TransactionRunOptions,
): Promise<T> {
  if (isPrisma7Client(client)) return client.$transaction(fn, options);
  return client.transaction(fn);
}

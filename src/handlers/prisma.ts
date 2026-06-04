/**
 * Injeção do cliente Prisma.
 *
 * O Prisma 7 gera o cliente dentro do próprio projeto (ex.: `@prisma-generated/client`),
 * portanto o pacote não pode importá-lo diretamente. Chame `setPrismaClient` uma vez
 * no bootstrap da aplicação antes de usar `Transactional` ou `withTransaction`.
 *
 * Exemplo:
 * ```ts
 * import prismaClient from "@database/prisma";
 * import { setPrismaClient } from "@qualitysistemas/bun-commons";
 * setPrismaClient(prismaClient);
 * ```
 */

export interface PrismaClientLike {
  $transaction<T>(
    fn: (tx: any) => Promise<T>,
    options?: {
      timeout?: number;
      /** ReadUncommitted | ReadCommitted | RepeatableRead | Snapshot | Serializable */
      isolationLevel?: string;
      maxWait?: number;
    },
  ): Promise<T>;
}

let _prismaClient: PrismaClientLike | null = null;

export function setPrismaClient(client: PrismaClientLike): void {
  _prismaClient = client;
}

export function getPrismaClient(): PrismaClientLike {
  if (!_prismaClient) {
    throw new Error(
      "[@QS-BUN] Prisma client não configurado. Chame setPrismaClient() no bootstrap da aplicação antes de usar Transactional/withTransaction.",
    );
  }
  return _prismaClient;
}

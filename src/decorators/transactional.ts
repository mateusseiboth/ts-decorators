/**
 * @Transactional - Decorator de método para garantir atomicidade.
 *
 * Envolve um método de controller em uma transação Prisma,
 * fazendo rollback automático se qualquer erro ocorrer.
 *
 * Funciona em dois modos:
 *
 * 1. **Decorator de método em rotas** (Express handler):
 *    Cria automaticamente a transação, injeta em `res.locals.tx`,
 *    chama `addCompanyIdToTransaction`, e faz rollback em caso de erro.
 *
 * 2. **Decorator de classe** em Controllers:
 *    Envolve métodos de escrita (create, update, deleteById) com
 *    savepoints para rollback parcial dentro de uma transação existente.
 *
 * Uso em rotas:
 *   router.post("/", Transactional(prismaClient), async (req, res) => {
 *     const controller = new MeuController(res.locals.tx, req.body);
 *     await controller.create(req, res);
 *   });
 *
 * Uso em controllers:
 *   @TransactionalClass
 *   class MeuController extends BaseController { ... }
 *
 */

import type { NextFunction, Request, Response } from "express";

import { logger } from "../functions/logger";
import { markCommitQueue, rollbackCommitQueue } from "../handlers/afterCommit";
import {
  getCompanyIdInjector,
  isContextualInjector,
  type CompanyIdInjector,
} from "../handlers/companyId";
import { runInTransaction, type PrismaClientLike } from "../handlers/prisma";
import { isPrisma7Tx, isPrisma8Tx, runStatement } from "../prisma8/client";
import { wrapMetodosDaClasse } from "./_method";

type PrismaLike = PrismaClientLike;

/** O retorno é ignorado: cabe o `addCompanyIdToTransaction`, que devolve o resultado do comando. */
type AddCompanyFn = (tx: any, entity: string) => unknown;

// Configuração global deste middleware. Opt-in: sem chamar `setTransactionalCompanyFn` (ou
// passar `companyIdInjector` na rota) nada é injetado na transação. `null` desliga de novo.
let _addCompanyFn: AddCompanyFn | null = null;

export function setTransactionalCompanyFn(fn: AddCompanyFn | null) {
  _addCompanyFn = fn;
}

/** A função registrada, ou `null`. Quem abre transação fora do `Transactional` também a usa. */
export function findTransactionalCompanyFn(): AddCompanyFn | null {
  return _addCompanyFn;
}

/** Esquece a função registrada (testes). */
export function clearTransactionalCompanyFn(): void {
  _addCompanyFn = null;
}

/**
 * Quando o @TransactionalClass gasta um SAVEPOINT em cada escrita.
 *
 * - `"auto"`: só a partir da SEGUNDA escrita da mesma transação — que
 *   é quando existe trabalho anterior para preservar. Um savepoint aberto antes
 *   da primeira escrita não protege nada: se ela falhar, voltar até ali é o
 *   mesmo que abortar a transação inteira, que é justamente o que o
 *   `Transactional` faz ao receber o erro.
 * - `"always"` (padrão): um savepoint por escrita, como sempre foi.
 * - `"never"`: nunca — a transação inteira é a unidade de rollback.
 *
 * `SAVEPOINT` + `RELEASE` são DUAS idas ao banco por escrita. Em `"auto"`, a
 * rota comum (uma escrita por request) deixa de pagar as duas — mas isso MUDA
 * comportamento, então é opt-in: `"auto"` quebra quem captura o erro de uma
 * escrita e SEGUE usando a mesma transação (sem savepoint o Postgres já abortou).
 */
export type SavepointPolicy = "auto" | "always" | "never";

let _savepointPolicy: SavepointPolicy = "always";

export function setSavepointPolicy(policy: SavepointPolicy): void {
  _savepointPolicy = policy;
}

export function getSavepointPolicy(): SavepointPolicy {
  return _savepointPolicy;
}

/** Escritas decoradas já executadas em cada transação (para a política "auto"). */
const _writesByTx = new WeakMap<object, number>();

/** Sequencial do nome do savepoint — `Date.now()` colidia dentro do mesmo ms. */
let _savepointSeq = 0;

/** Decide se ESTA escrita abre um savepoint, e contabiliza a escrita na transação. */
const savepointDecision: Record<SavepointPolicy, (tx: object) => boolean> = {
  never: () => false,
  always: () => true,
  auto: (tx) => (_writesByTx.get(tx) ?? 0) > 0,
};

/**
 * O injetor do middleware: o da rota, o do `setTransactionalCompanyFn`, ou o global quando ele é
 * contextual (as GUCs do `configureTenantGucs`), que vale mesmo sem nada registrado aqui.
 */
const resolveAddCompany = (daRota: CompanyIdInjector | undefined) => {
  const global = getCompanyIdInjector();
  return daRota ?? _addCompanyFn ?? (isContextualInjector(global) ? global : null);
};

/** Injetor que lê o tenant do contexto: roda sem `res.locals.entity` (o super admin). */
const isContextual = (addCompany: unknown) =>
  isContextualInjector(addCompany) || isContextualInjector(getCompanyIdInjector());

/**
 * Middleware factory: cria uma transação e injeta em res.locals.tx.
 * Uso: router.post("/", Transactional(prismaClient), handler)
 */
export function Transactional(
  prisma: PrismaLike,
  options?: {
    timeout?: number;
    maxWait?: number;
    /** Estratégia de tenant só desta rota; vence o `setTransactionalCompanyFn`. */
    companyIdInjector?: CompanyIdInjector;
  },
) {
  return function (req: Request, res: Response, next: NextFunction) {
    runInTransaction(
      prisma,
      async (tx) => {
        const addCompany = resolveAddCompany(options?.companyIdInjector);
        if (addCompany && (res.locals.entity || isContextual(addCompany))) {
          await addCompany(tx, res.locals.entity);
        }
        res.locals.tx = tx;

        // Aguarda o próximo handler terminar dentro da transação
        await new Promise<void>((resolve, reject) => {
          // Detecta quando a resposta foi enviada
          const onFinish = () => {
            cleanup();
            if (res.statusCode >= 400) {
              reject(new TransactionAbortError(`Response status ${res.statusCode}`));
            } else {
              resolve();
            }
          };

          const onError = (err: Error) => {
            cleanup();
            reject(err);
          };

          const cleanup = () => {
            res.removeListener("finish", onFinish);
            res.removeListener("error", onError);
          };

          res.on("finish", onFinish);
          res.on("error", onError);

          // Chama o próximo handler
          next();
        });
      },
      {
        maxWait: options?.maxWait || 30_000,
        timeout: options?.timeout || 30_000,
      },
    ).catch((err) => {
      // Se já respondeu, não faz nada (rollback já aconteceu)
      if (res.headersSent) {
        if (!(err instanceof TransactionAbortError)) {
          logger.error(
            "[@mateusseiboth/ts-decorators] Transactional: Erro pós-resposta (rollback executado):",
            err.message,
          );
        }
        return;
      }
      next(err);
    });
  };
}

const WRITE_METHODS = ["create", "update", "deleteById"];
const MARCA_TRANSACTIONAL = Symbol("ts-decorators:transactional");

/**
 * Decorator de classe: envolve métodos de escrita com savepoints, os herdados da classe base
 * inclusive.
 * Requer que this.DAO.tx já seja uma transação (Prisma 7 ou Prisma 8).
 */
export function TransactionalClass<T extends { new (...args: any[]): any }>(
  constructor: T,
  _context?: ClassDecoratorContext,
): T {
  wrapMetodosDaClasse(constructor, MARCA_TRANSACTIONAL, ({ name: methodName, original }) => {
    if (!WRITE_METHODS.includes(methodName)) return undefined;
    const originalMethod = original;

    return async function (this: any, ...args: any[]) {
      const tx = this.DAO?.tx;
      if (!isPrisma7Tx(tx) && !isPrisma8Tx(tx)) return originalMethod.call(this, ...args);

      const useSavepoint = savepointDecision[_savepointPolicy](tx);
      _writesByTx.set(tx, (_writesByTx.get(tx) ?? 0) + 1);

      if (!useSavepoint) return originalMethod.call(this, ...args);

      const savepointName = `sp_${methodName}_${++_savepointSeq}`;
      // Os ganchos afterCommit da escrita revertida pelo savepoint vão embora com ela.
      const commitMark = markCommitQueue(tx);
      try {
        await runStatement(tx, `SAVEPOINT "${savepointName}"`);
        logger.debug(
          () =>
            `[@mateusseiboth/ts-decorators] Transactional: ${constructor.name}.${methodName} → SAVEPOINT criado (${savepointName})`,
        );
        const result = await originalMethod.call(this, ...args);
        await runStatement(tx, `RELEASE SAVEPOINT "${savepointName}"`);
        logger.debug(
          () =>
            `[@mateusseiboth/ts-decorators] Transactional: ${constructor.name}.${methodName} → SAVEPOINT liberado (${savepointName})`,
        );
        return result;
      } catch (err) {
        rollbackCommitQueue(tx, commitMark);
        try {
          await runStatement(tx, `ROLLBACK TO SAVEPOINT "${savepointName}"`);
          logger.debug(
            () =>
              `[@mateusseiboth/ts-decorators] Transactional: ${constructor.name}.${methodName} → SAVEPOINT revertido (${savepointName})`,
          );
        } catch {
          // Savepoint pode já ter sido rolled back
        }
        throw err;
      }
    };
  });

  return constructor;
}

/**
 * Erro interno para sinalizar que a transação deve ser abortada.
 * Não deve ser exposto ao usuário.
 */
class TransactionAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionAbortError";
  }
}

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

import type {NextFunction, Request, Response} from "express";
import {isDecoratorContext, warnLegacy} from "./_proxy";

type PrismaLike = {
  $transaction: (fn: (tx: any) => Promise<any>, options?: any) => Promise<any>;
};

type AddCompanyFn = (tx: any, entity: string) => Promise<void>;

// Configuração global
let _addCompanyFn: AddCompanyFn | null = null;

export function setTransactionalCompanyFn(fn: AddCompanyFn) {
  _addCompanyFn = fn;
}

/**
 * Middleware factory: cria uma transação e injeta em res.locals.tx.
 * Uso: router.post("/", Transactional(prismaClient), handler)
 */
export function Transactional(prisma: PrismaLike, options?: {timeout?: number; maxWait?: number}) {
  return function (req: Request, res: Response, next: NextFunction) {
    prisma
      .$transaction(
        async (tx) => {
          if (_addCompanyFn && res.locals.entity) {
            await _addCompanyFn(tx, res.locals.entity);
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
      )
      .catch((err) => {
        // Se já respondeu, não faz nada (rollback já aconteceu)
        if (res.headersSent) {
          if (!(err instanceof TransactionAbortError)) {
            console.error("[@mateusseiboth/ts-commons] Transactional: Erro pós-resposta (rollback executado):", err.message);
          }
          return;
        }
        next(err);
      });
  };
}

/**
 * Decorator de classe: envolve métodos de escrita com savepoints.
 * Requer que this.DAO.tx já seja uma TransactionClient.
 */
export function TransactionalClass<T extends {new (...args: any[]): any}>(constructor: T, context?: ClassDecoratorContext): T {
  if (!context || !isDecoratorContext(context)) {
    warnLegacy("TransactionalClass");
  }
  const writeMethods = ["create", "update", "deleteById"];

  for (const methodName of Object.getOwnPropertyNames(constructor.prototype)) {
    if (methodName === "constructor") continue;
    if (!writeMethods.includes(methodName)) continue;

    const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, methodName);
    if (!descriptor || typeof descriptor.value !== "function") continue;

    const originalMethod = descriptor.value;

    descriptor.value = async function (this: any, ...args: any[]) {
      const tx = this.DAO?.tx;

      // Se tem transação, cria um savepoint para rollback parcial
      if (tx?.$executeRawUnsafe) {
        const savepointName = `sp_${methodName}_${Date.now()}`;
        try {
          await tx.$executeRawUnsafe(`SAVEPOINT "${savepointName}"`);
          console.log(`[@mateusseiboth/ts-commons] Transactional: ${constructor.name}.${methodName} → SAVEPOINT criado (${savepointName})`);
          const result = await originalMethod.call(this, ...args);
          await tx.$executeRawUnsafe(`RELEASE SAVEPOINT "${savepointName}"`);
          console.log(
            `[@mateusseiboth/ts-commons] Transactional: ${constructor.name}.${methodName} → SAVEPOINT liberado (${savepointName})`,
          );
          return result;
        } catch (err) {
          try {
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "${savepointName}"`);
            console.log(
              `[@mateusseiboth/ts-commons] Transactional: ${constructor.name}.${methodName} → SAVEPOINT revertido (${savepointName})`,
            );
          } catch {
            // Savepoint pode já ter sido rolled back
          }
          throw err;
        }
      }

      // Sem transação: executa normalmente
      return originalMethod.call(this, ...args);
    };

    Object.defineProperty(constructor.prototype, methodName, descriptor);
  }

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

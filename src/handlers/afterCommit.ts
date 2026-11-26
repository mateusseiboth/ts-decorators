/**
 * Ganchos de depois do commit. O `runInTransaction` abre uma fila para cada transação: o que
 * entra por `afterCommit(tx, fn)` só roda quando ela COMITA, na ordem em que entrou. Rollback (ou
 * commit que falha) descarta a fila. O `ROLLBACK TO SAVEPOINT` do `@TransactionalClass` descarta
 * só o que entrou depois do savepoint.
 *
 * Resolve o evento fantasma: o e-mail, o job ou a invalidação de cache disparados por uma escrita
 * que acabou desfeita, e o listener que consulta o banco antes do commit e não acha o registro.
 */
import { logger } from "../functions/logger";

type CommitHook = () => unknown;

interface CommitQueue {
  hooks: CommitHook[];
  /** Fechada depois do commit ou do rollback: gancho novo roda na hora. */
  closed: boolean;
}

const _queues = new WeakMap<object, CommitQueue>();
let _warnedUntracked = false;

const logHookError = (error: unknown) =>
  logger.error("[@mateusseiboth/ts-decorators] afterCommit: o gancho falhou:", error);

/** Começa na hora; gancho assíncrono segue sozinho, com o erro no log. */
function runNow(hook: CommitHook): void {
  try {
    const result = hook();
    if (result instanceof Promise) result.catch(logHookError);
  } catch (error) {
    logHookError(error);
  }
}

/** Chamado pelo `runInTransaction` logo que a transação abre. */
export function openCommitQueue(tx: unknown): void {
  if (tx && typeof tx === "object") _queues.set(tx, { hooks: [], closed: false });
}

/** Depois do commit: roda os ganchos em ordem; o erro de um não impede os outros. */
export async function flushCommitQueue(tx: unknown): Promise<void> {
  const queue = readQueue(tx);
  if (!queue) return;
  queue.closed = true;
  const hooks = queue.hooks.splice(0);
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      logger.error(
        "[@mateusseiboth/ts-decorators] afterCommit: o gancho falhou depois do commit:",
        error,
      );
    }
  }
}

/** Depois do rollback: o que estava na fila nunca aconteceu. */
export function discardCommitQueue(tx: unknown): void {
  const queue = readQueue(tx);
  if (!queue) return;
  queue.closed = true;
  queue.hooks.length = 0;
}

/** Marca o ponto do savepoint; `rollbackCommitQueue` volta a fila até ele. */
export function markCommitQueue(tx: unknown): number {
  return readQueue(tx)?.hooks.length ?? 0;
}

export function rollbackCommitQueue(tx: unknown, mark: number): void {
  readQueue(tx)?.hooks.splice(mark);
}

function readQueue(tx: unknown): CommitQueue | undefined {
  return tx && typeof tx === "object" ? _queues.get(tx) : undefined;
}

function warnUntracked(): void {
  if (_warnedUntracked) return;
  _warnedUntracked = true;
  logger.warn(
    "[@mateusseiboth/ts-decorators] afterCommit recebeu uma transação que o pacote não abriu e rodou o gancho na hora. " +
      "Abra a transação por runInTransaction, withTransaction ou Transactional.",
  );
}

/**
 * Roda `fn` depois do commit de `tx`. Sem transação, roda na hora (não há o que esperar). Com
 * uma transação que o pacote não abriu, também roda na hora e avisa uma vez: não há como saber
 * quando ela comita.
 */
export function afterCommit(tx: unknown, fn: () => unknown): void {
  const queue = readQueue(tx);
  if (queue && !queue.closed) {
    queue.hooks.push(fn);
    return;
  }
  if (tx && !queue) warnUntracked();
  runNow(fn);
}

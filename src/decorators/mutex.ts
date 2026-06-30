/**
 * @Mutex(keyFn?) — serializa as chamadas a um método (uma execução por vez).
 *
 * Cada instância tem seu próprio lock por nome de método. Com `keyFn` é possível
 * particionar o lock (ex.: uma fila por id de recurso).
 *
 * Uso:
 *   @Mutex()
 *   async atualizarSaldo(req, res) { ... }
 */

import {Mutex as MutexPrimitive} from "../concurrency/Mutex";
import {makeMethodDecorator} from "./_method";

const STORE = Symbol("mutex:locks");

function getLock(instance: any, key: string): MutexPrimitive {
  const locks: Map<string, MutexPrimitive> = instance[STORE] ?? (instance[STORE] = new Map());
  let lock = locks.get(key);
  if (!lock) {
    lock = new MutexPrimitive();
    locks.set(key, lock);
  }
  return lock;
}

export function Mutex(keyFn?: (...args: any[]) => string) {
  return makeMethodDecorator("Mutex", (original, methodName) => {
    return async function (this: any, ...args: any[]) {
      const key = keyFn ? `${methodName}:${keyFn(...args)}` : methodName;
      return getLock(this, key).runExclusive(() => original.apply(this, args));
    };
  });
}

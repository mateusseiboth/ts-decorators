/**
 * @Singleton / @Scoped / @Transient — definem o ciclo de vida da instância
 * resolvida pelo `container` (DI).
 *
 *  - @Singleton(): uma única instância por processo (default do container).
 *  - @Scoped(keyFn?): uma instância por chave de escopo. Sem `keyFn`, usa o
 *    resolver global (`container.setScopeResolver`) — no SIART, o requestId.
 *  - @Transient(): uma instância nova a cada `container.get()`.
 *
 * Funcionam tanto no padrão legacy (experimentalDecorators) quanto TC39 Stage 3,
 * pois apenas gravam metadata no construtor.
 */

import "reflect-metadata";
import {isDecoratorContext, warnLegacy} from "./_proxy";

const DI_SCOPE_KEY = "di:scope";
const DI_SCOPE_KEYFN = "di:scopeKeyFn";

export type DiScope = "singleton" | "scoped" | "transient";

function defineScope(name: string, scope: DiScope, keyFn?: () => string) {
  return function (target: any, context?: ClassDecoratorContext): any {
    if (!context || !isDecoratorContext(context)) {
      warnLegacy(name);
    }
    Reflect.defineMetadata(DI_SCOPE_KEY, scope, target);
    if (keyFn) Reflect.defineMetadata(DI_SCOPE_KEYFN, keyFn, target);
    return target;
  };
}

export function Singleton(): ClassDecorator {
  return defineScope("Singleton", "singleton") as ClassDecorator;
}

export function Scoped(keyFn?: () => string): ClassDecorator {
  return defineScope("Scoped", "scoped", keyFn) as ClassDecorator;
}

export function Transient(): ClassDecorator {
  return defineScope("Transient", "transient") as ClassDecorator;
}

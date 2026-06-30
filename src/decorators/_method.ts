/**
 * Helper interno para criar decorators de MÉTODO que suportam tanto o padrão
 * legacy (experimentalDecorators) quanto o TC39 Stage 3, evitando duplicar a
 * detecção de contexto em cada decorator.
 *
 * `build(original, methodName)` deve retornar a função substituta do método.
 */

import {isDecoratorContext, warnLegacy} from "./_proxy";

export type MethodWrapper = (original: Function, methodName: string) => Function;

export function makeMethodDecorator(name: string, build: MethodWrapper) {
  return function (...args: any[]): any {
    // TC39 Stage 3: (method, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
      const original = args[0] as Function;
      const methodName = String(args[1].name);
      return build(original, methodName);
    }

    // Legacy: (target, propertyKey, descriptor)
    warnLegacy(name);
    const propertyKey = args[1] as string;
    const descriptor = args[2] as PropertyDescriptor;
    descriptor.value = build(descriptor.value, propertyKey);
    return descriptor;
  };
}

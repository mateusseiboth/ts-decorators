import "reflect-metadata";
import {isDecoratorContext, warnLegacy} from "./_proxy";

const NESTED_MODELS = new WeakMap<object, Record<string, any>>();

/**
 * @NestedModel - Decorator de propriedade/campo.
 * Suporta legacy e TC39 Stage 3.
 */
export function NestedModel(modelClass: Function) {
  console.log(`[@mateusseiboth/ts-commons] Registering nested model:`, modelClass.name);
  return function (...args: any[]): any {
    // New TC39 field decorator: (value, context)
    if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "field") {
      const context = args[1] as ClassFieldDecoratorContext;
      const fieldName = String(context.name);
      const meta = context.metadata as Record<string, any>;
      if (!meta.__nested) meta.__nested = {};
      meta.__nested[fieldName] = modelClass;
      return;
    }

    // Legacy property decorator: (target, propertyKey)
    warnLegacy("NestedModel");
    const [target, propertyKey] = args;
    let nested = NESTED_MODELS.get(target);
    if (!nested) {
      nested = {};
      NESTED_MODELS.set(target, nested);
    }
    nested[propertyKey as string] = modelClass;
  };
}

export function getNestedModel(target: any, key: string): any | undefined {
  // Legacy: walk prototype chain
  let proto = target;
  while (proto && proto !== Object.prototype) {
    const nested = NESTED_MODELS.get(proto);
    if (nested && nested[key]) return nested[key];
    proto = Object.getPrototypeOf(proto);
  }

  // New TC39: check Symbol.metadata
  const ctor = typeof target === "function" ? target : target?.constructor;
  if (ctor && typeof Symbol !== "undefined" && Symbol.metadata) {
    const meta = ctor[Symbol.metadata] as Record<string, any> | undefined;
    if (meta?.__nested && meta.__nested[key]) {
      return meta.__nested[key];
    }
  }

  return undefined;
}

import {isDecoratorContext, warnLegacy} from "./_proxy";

export function logDecorator<T extends {new (...args: any[]): {}}>(constructor: T, context?: ClassDecoratorContext): T {
  if (!context || !isDecoratorContext(context)) {
    warnLegacy("logDecorator");
  }
  const className = constructor.name;

  for (const propertyName of Object.getOwnPropertyNames(constructor.prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, propertyName);
    if (!descriptor || propertyName === "constructor") continue;

    const originalMethod = descriptor.value;
    const methodName = propertyName; // Capture method name here

    descriptor.value = function (...args: any[]) {
      console.log = (message: any, ...optionalParams: any[]) => {
        const timestamp = new Date().toLocaleString("pt-BR", {timeZone: "America/Campo_Grande"});
        (global as any)._console.call(console, `[${timestamp} - ${className} -> ${methodName}]`, message, ...optionalParams);
      };

      try {
        const result = originalMethod.apply(this, args);
        return result;
      } catch (error) {
        throw error;
      }
    };

    Object.defineProperty(constructor.prototype, propertyName, descriptor);
  }

  return constructor;
}

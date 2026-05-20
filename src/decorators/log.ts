import {isDecoratorContext, warnLegacy} from "./_proxy";

export function logDecorator<T extends new (...args: any[]) => {}>(constructor: T, context?: ClassDecoratorContext): T {
  if (!context || !isDecoratorContext(context)) {
    warnLegacy("logDecorator");
  }

  const className = constructor.name;

  // Injeta um método de logging na classe
  Object.defineProperty(constructor.prototype, "log", {
    value: function (message: string) {
      const timestamp = new Date().toLocaleString("pt-BR", {
        timeZone: "America/Campo_Grande",
      });

      console.log(`[${timestamp} - ${className}] ${message}`);
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return constructor;
}

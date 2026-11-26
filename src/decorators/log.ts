import { logger } from "../functions/logger";

export function logDecorator<T extends new (...args: any[]) => {}>(
  constructor: T,
  _context?: ClassDecoratorContext,
): T {
  const className = constructor.name;

  // Injeta um método de logging na classe
  Object.defineProperty(constructor.prototype, "log", {
    value: function (message: string) {
      const timestamp = new Date().toLocaleString("pt-BR", {
        timeZone: "America/Campo_Grande",
      });

      logger.info(`[${timestamp} - ${className}] ${message}`);
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return constructor;
}

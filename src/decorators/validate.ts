import "reflect-metadata";
import type {ZodSchema} from "zod";
import {isDecoratorContext, warnLegacy} from "./_proxy";

const VALIDATION_META_KEY = Symbol("validation:schema");

/**
 * @Validate - Decorator de parâmetro.
 * NOTA: TC39 Stage 3 NÃO suporta parameter decorators.
 * Este decorator funciona apenas no padrão legacy (experimentalDecorators).
 */
export function Validate(schema: ZodSchema) {
  return function (target: Object, propertyKey: string | symbol | undefined, parameterIndex: number) {
    warnLegacy("Validate");
    Reflect.defineMetadata(VALIDATION_META_KEY, schema, target, `param_${parameterIndex}`);
  };
}

/**
 * @WithValidation - Decorator de classe.
 * Suporta legacy e TC39 Stage 3.
 */
export function WithValidation<T extends {new (...args: any[]): {}}>(constructor: T, context?: ClassDecoratorContext) {
  if (!context || !isDecoratorContext(context)) {
    warnLegacy("WithValidation");
  }
  return class extends constructor {
    constructor(...args: any[]) {
      const paramSchemas = Object.keys(Reflect.getMetadataKeys(constructor.prototype) || [])
        .map((key) => {
          if (key.startsWith("param_")) {
            const index = Number(key.replace("param_", ""));
            return {index, schema: Reflect.getMetadata(VALIDATION_META_KEY, constructor.prototype, key)};
          }
          return null;
        })
        .filter(Boolean) as {index: number; schema: ZodSchema}[];

      // Valida cada parâmetro decorado
      for (const {index, schema} of paramSchemas) {
        schema.parse(args[index]);
      }

      super(...args);
    }
  };
}

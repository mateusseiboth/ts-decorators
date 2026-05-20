import "reflect-metadata";
import type {ZodSchema} from "zod";
import {isDecoratorContext, warnLegacy} from "./_proxy";

export interface IWithValidation<T = unknown> {
  schema?: ZodSchema<T>;

  validate(schema?: ZodSchema<T>): T;

  isValid(schema?: ZodSchema<T>): boolean;
}

/**
 * Compat legacy.
 * NÃO faz nada.
 */
export function Validate(_schema: ZodSchema) {
  return function (_target: any, _propertyKey: string | symbol | undefined, _parameterIndex: number) {
    warnLegacy("Validate");
  };
}

function createValidationDecorator<TSchema = unknown>(schema?: ZodSchema<TSchema>) {
  return function <T extends new (...args: any[]) => {}>(OriginalConstructor: T, context?: ClassDecoratorContext) {
    if (!context || !isDecoratorContext(context)) {
      warnLegacy("WithValidation");
    }

    return class extends OriginalConstructor implements IWithValidation<TSchema> {
      static schema = schema;

      schema = schema;

      validate(customSchema?: ZodSchema<TSchema>): TSchema {
        const finalSchema = customSchema ?? this.schema ?? (this.constructor as any).schema;

        if (!finalSchema) {
          throw new Error(`[WithValidation] No validation schema defined for "${this.constructor.name}".`);
        }

        return finalSchema.parse(this);
      }

      isValid(customSchema?: ZodSchema<TSchema>): boolean {
        try {
          this.validate(customSchema);
          return true;
        } catch {
          return false;
        }
      }
    };
  };
}

/**
 * Suporta:
 *
 * @WithValidation
 * @WithValidation(schema)
 * WithValidation(Class)
 */
export function WithValidation(...args: any[]): any {
  // @WithValidation
  if (typeof args[0] === "function" && args.length <= 2) {
    const [constructor, context] = args;

    return createValidationDecorator()(constructor, context);
  }

  // @WithValidation(schema)
  return createValidationDecorator(args[0]);
}

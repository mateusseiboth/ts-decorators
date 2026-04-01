import {isDecoratorContext, warnLegacy} from "./_proxy";
import {getFieldTypeByKey, getFieldTypes} from "./initFields";

/** Cria a função wrapper que faz a auto-conversão de tipos */
function wrapWithAutoConvert(originalMethod: Function) {
  return function (this: any, data: any) {
    const keysInModel = getFieldTypes(this);
    if (!data) return originalMethod.call(this, data);

    Object.keys(data).forEach((key) => {
      if (key in keysInModel) {
        const type = getFieldTypeByKey(this, key as keyof typeof this as string);
        let val = data[key];

        if (val === null || val === undefined) {
          data[key] = null;
          return;
        }

        switch (type?.toLowerCase()) {
          case "number":
            const n = Number(val);
            data[key] = isNaN(n) ? null : n;
            break;

          case "bigint":
            try {
              data[key] = BigInt(val);
            } catch {
              data[key] = null;
            }
            break;

          case "boolean":
            data[key] =
              val === "false" || val === 0 || val === "0" || val === "N"
                ? false
                : data[key] === "true" || val === 1 || val === "1" || val === "S"
                  ? true
                  : Boolean(val);
            break;

          case "date":
            if (val instanceof Date) {
              // mantém a data
            } else {
              if (val === 0 || val === "0") {
                data[key] = null;
                break;
              }
              const d = new Date(val);
              data[key] = isNaN(d.getTime()) ? null : d;
            }
            break;

          case "string":
            data[key] = String(val);
            break;

          default:
            // mantém original
            break;
        }
      }
    });

    return originalMethod.call(this, data);
  };
}

/**
 * @AutoConvert - Decorator de método.
 * Suporta tanto o padrão legacy quanto o TC39 Stage 3.
 */
export function AutoConvert(...args: any[]): any {
  // New TC39 method decorator: (method, context)
  if (args.length === 2 && isDecoratorContext(args[1]) && args[1].kind === "method") {
    return wrapWithAutoConvert(args[0] as Function);
  }

  // Legacy method decorator: (target, propertyKey, descriptor)
  warnLegacy("AutoConvert");
  const descriptor = args[2] as PropertyDescriptor;
  descriptor.value = wrapWithAutoConvert(descriptor.value);
}

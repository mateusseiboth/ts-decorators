import { getFieldTypes } from "../decorators/initFields";
import { getNestedModel } from "../decorators/nestedModel";

export function collectFieldTypes(instance: any, prefix = ""): Record<string, string> {
    const fields = getFieldTypes(instance);
    const result: Record<string, string> = {};

    for (const key in fields) {
        //@ts-expect-error dynamic key, possible injection
        result[`${prefix}${key}`] = fields[key];

        const nestedClass = getNestedModel(instance, key);
        if (nestedClass) {
            const nestedInstance = new nestedClass();
            const nestedFields = collectFieldTypes(nestedInstance, `${prefix}${key}.`);
            Object.assign(result, nestedFields);
        }
    }

    return result;
}
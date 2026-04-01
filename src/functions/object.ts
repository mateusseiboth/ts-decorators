import { getModel } from "../decorators/getModel";
import { getFieldTypes } from "../decorators/initFields";


export function filterObjectByModel<T extends object, U extends object>(
    obj: T,
    Model: { getModel: () => U, tag: number }
): Partial<U> {
    const result: U = {} as U;
    const classRecord = getModel(Model.tag);
    const keys = Object.keys(getFieldTypes(classRecord.prototype) as T extends { [key: string]: any } ? T : never);
    const modelKeys = getFieldTypes(classRecord.prototype);
    for (const key of keys) {
        if (key in obj) {
            result[key as keyof U] = obj[key as keyof T] as unknown as U[keyof U];
        }
    }
    return result;
}

export function getModelKeys(modelClass: any) {
    const protoKeys: string[] = [];
    let proto = modelClass.prototype;

    while (proto && proto !== Object.prototype) {
        const fields: string[] = Reflect.getMetadata('fields', proto) || [];
        protoKeys.push(...fields);
        proto = Object.getPrototypeOf(proto);
    }

    return Array.from(new Set(protoKeys));
}

import {getFieldTypes} from "../decorators/initFields";
import {getNestedModelMeta} from "../decorators/nestedModel";

/**
 * Coleta (recursivamente) os tipos de campo de um model, achatando relações
 * aninhadas to-one em chaves com ponto (ex.: `bairro.name`) que o getWhere usa
 * para montar filtros aninhados.
 *
 * - Relações to-one (objeto único) são expandidas — comportamento histórico.
 * - Relações to-many (`@Field([Model])`) NÃO são expandidas: a notação por
 *   ponto não é válida para filtros de lista no Prisma (exigiria `some`/`every`),
 *   então evitamos gerar where clauses inválidas.
 * - `ancestors` evita recursão infinita em relações cíclicas.
 */
export function collectFieldTypes(instance: any, prefix = "", ancestors: Set<any> = new Set()): Record<string, string> {
    const fields = getFieldTypes(instance);
    const result: Record<string, string> = {};

    const ctor = instance?.constructor;
    if (ctor && ancestors.has(ctor)) return result; // ciclo detectado
    const nextAncestors = new Set(ancestors);
    if (ctor) nextAncestors.add(ctor);

    for (const key in fields) {
        //@ts-expect-error dynamic key, possible injection
        result[`${prefix}${key}`] = fields[key];

        const nestedMeta = getNestedModelMeta(instance, key);
        if (nestedMeta && !nestedMeta.isArray) {
            const nestedInstance = new (nestedMeta.model as any)();
            const nestedFields = collectFieldTypes(nestedInstance, `${prefix}${key}.`, nextAncestors);
            Object.assign(result, nestedFields);
        }
    }

    return result;
}

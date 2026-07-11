import {getFieldTypes} from "../decorators/initFields";
import {getNestedModelMeta} from "../decorators/nestedModel";

/**
 * Metadados achatados de um model, usados pelo getWhere para montar filtros.
 */
export interface FieldMeta {
    /**
     * Tipos de campo achatados por chave, incluindo relações aninhadas em
     * notação com ponto (ex.: `bairro.name`, `posts.title`).
     */
    types: Record<string, string>;
    /**
     * Dot-paths que correspondem a relações to-many (`@Field([Model])`).
     * O getWhere usa esse conjunto para envolver o segmento com `some` e gerar
     * um filtro de lista válido no Prisma (ex.: `{posts: {some: {...}}}`).
     */
    listPaths: Set<string>;
}

/**
 * Coleta (recursivamente) os tipos de campo de um model, achatando relações
 * aninhadas em chaves com ponto que o getWhere usa para montar filtros.
 *
 * - Relações to-one (objeto único) são expandidas como `relacao.campo`.
 * - Relações to-many (`@Field([Model])`) também são expandidas, mas o caminho
 *   da relação é registrado em `listPaths` para que o getWhere envolva o
 *   segmento com `some` (a notação por ponto sozinha não é válida para listas
 *   no Prisma).
 * - `ancestors` evita recursão infinita em relações cíclicas.
 */
export function collectFieldMeta(instance: any, prefix = "", ancestors: Set<any> = new Set()): FieldMeta {
    const fields = getFieldTypes(instance);
    const types: Record<string, string> = {};
    const listPaths = new Set<string>();

    const ctor = instance?.constructor;
    if (ctor && ancestors.has(ctor)) return {types, listPaths}; // ciclo detectado
    const nextAncestors = new Set(ancestors);
    if (ctor) nextAncestors.add(ctor);

    for (const key in fields) {
        const path = `${prefix}${key}`;
        //@ts-ignore dynamic key, possible injection
        types[path] = fields[key];

        const nestedMeta = getNestedModelMeta(instance, key);
        if (nestedMeta) {
            if (nestedMeta.isArray) listPaths.add(path);
            const nestedInstance = new (nestedMeta.model as any)();
            const child = collectFieldMeta(nestedInstance, `${path}.`, nextAncestors);
            Object.assign(types, child.types);
            child.listPaths.forEach((p) => listPaths.add(p));
        }
    }

    return {types, listPaths};
}

/**
 * Atalho que retorna apenas o mapa de tipos achatados (relações to-one e
 * to-many). Mantido para retrocompatibilidade da API pública.
 */
export function collectFieldTypes(instance: any, prefix = "", ancestors: Set<any> = new Set()): Record<string, string> {
    return collectFieldMeta(instance, prefix, ancestors).types;
}

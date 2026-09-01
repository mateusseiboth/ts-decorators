import { getFieldTypes } from "../decorators/initFields";
import { createMetadataCache } from "../decorators/metadata";
import { getNestedModels } from "../decorators/nestedModel";

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
 * Resultado por model, sem prefixo — o caso de 100% das requisições. A árvore
 * inteira (relações aninhadas incluídas) é montada uma vez por classe.
 */
const FIELD_META_CACHE = createMetadataCache<object, FieldMeta>();

/**
 * A caminhada usa o PROTOTYPE do model aninhado, nunca `new Model()`.
 * Instanciar rodava o construtor do model (datas, BigInt, defaults) a cada
 * requisição só para descobrir nomes de campo — e o prototype responde o mesmo.
 */
function walk(target: any, prefix: string, ancestors: Set<any>): FieldMeta {
  const fields = getFieldTypes(target);
  const nestedModels = getNestedModels(target);
  const types: Record<string, string> = {};
  const listPaths = new Set<string>();

  const ctor = typeof target === "function" ? target : target?.constructor;
  if (ctor && ancestors.has(ctor)) return { types, listPaths }; // ciclo detectado
  const nextAncestors = new Set(ancestors);
  if (ctor) nextAncestors.add(ctor);

  for (const key in fields) {
    const path = `${prefix}${key}`;
    types[path] = fields[key] as string;

    const nestedMeta = nestedModels[key];
    if (!nestedMeta) continue;

    if (nestedMeta.isArray) listPaths.add(path);
    const child = walk((nestedMeta.model as any).prototype, `${path}.`, nextAncestors);
    Object.assign(types, child.types);
    child.listPaths.forEach((p) => listPaths.add(p));
  }

  return { types, listPaths };
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
 *
 * O resultado sem prefixo é memorizado por model — trate-o como SOMENTE LEITURA.
 */
export function collectFieldMeta(
  instance: any,
  prefix = "",
  ancestors: Set<any> = new Set(),
): FieldMeta {
  const cacheable = prefix === "" && ancestors.size === 0;
  if (!cacheable || !instance || typeof instance !== "object") {
    return walk(instance, prefix, ancestors);
  }

  return FIELD_META_CACHE.get(instance as object, (target) => {
    const meta = walk(target, "", new Set());
    Object.freeze(meta.types);
    return Object.freeze(meta);
  });
}

/**
 * Atalho que retorna apenas o mapa de tipos achatados (relações to-one e
 * to-many). Mantido para retrocompatibilidade da API pública.
 */
export function collectFieldTypes(
  instance: any,
  prefix = "",
  ancestors: Set<any> = new Set(),
): Record<string, string> {
  return collectFieldMeta(instance, prefix, ancestors).types;
}

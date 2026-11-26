/**
 * Factory do catálogo: a descoberta (`getAllModels` → CRUD padrão) somada à agregação do app
 * (ações custom e tags sem Model). Fonte única de recursos, ações e condições, memoizada na
 * primeira chamada, quando as rotas já importaram todos os Models.
 *
 * Tag NEGATIVA nunca entra: é passe livre para qualquer usuário autenticado, não tem o que marcar
 * na matriz.
 */
import { getAllModels } from "../decorators/getModel";
import { logger } from "../functions/logger";
import { requirePermissionsConfig, type ResolvedPermissionsConfig } from "./config";
import { CRUD_ACTIONS, CUSTOM_TAG_MIN } from "./constants";
import type {
  ActionKey,
  CatalogAction,
  CatalogResource,
  PermissionActionDef,
  ResourceAugmentation,
} from "./types";

interface DiscoveredResource {
  tag: number;
  label: string;
  custom: boolean;
}

/** O que a descoberta lê de um Model decorado com `@ModelTagged`. */
interface TaggedModel {
  nome?: unknown;
  tag?: unknown;
}

type IdentifiedModel = { nome: string; tag: number };

const hasIdentidade = (model: TaggedModel): model is IdentifiedModel =>
  typeof model.nome === "string" &&
  model.nome !== "" &&
  Number.isInteger(model.tag) &&
  Number(model.tag) >= 0;

function discoverModels(): DiscoveredResource[] {
  return (getAllModels() as TaggedModel[])
    .filter(hasIdentidade)
    .map((model) => ({ tag: model.tag, label: model.nome, custom: false }));
}

function requireLabel(tag: number, augmentation: ResourceAugmentation): string {
  if (!augmentation.label) {
    throw new Error(
      `[@mateusseiboth/ts-decorators] Tag custom ${tag} do catálogo precisa de 'label' (não há Model).`,
    );
  }
  return augmentation.label;
}

function discoverCustomTags(
  config: ResolvedPermissionsConfig,
  modelTags: Set<number>,
): DiscoveredResource[] {
  return Object.entries(config.catalog)
    .map(([tag, augmentation]) => ({ tag: Number(tag), augmentation }))
    .filter(({ tag }) => tag >= CUSTOM_TAG_MIN && !modelTags.has(tag))
    .map(({ tag, augmentation }) => ({
      tag,
      label: requireLabel(tag, augmentation),
      custom: true,
    }));
}

function toCatalogAction(action: ActionKey, definition: PermissionActionDef): CatalogAction {
  const conditions = definition.conditions;
  const hasConditions = !!conditions && Object.keys(conditions).length > 0;
  return {
    action,
    label: definition.label,
    hasConditions,
    conditions: hasConditions ? conditions : undefined,
  };
}

const CRUD_DEFS: Readonly<Record<ActionKey, PermissionActionDef>> = Object.fromEntries(
  Object.entries(CRUD_ACTIONS).map(([action, label]) => [action, { label }]),
);

/** Recurso com Model herda o CRUD; recurso custom só tem o que o catálogo declarar. */
function resolveActions(
  resource: DiscoveredResource,
  augmentation: ResourceAugmentation | undefined,
): CatalogAction[] {
  const base = resource.custom ? {} : CRUD_DEFS;
  const merged: Record<ActionKey, PermissionActionDef> = {
    ...base,
    ...augmentation?.actions,
  };
  return Object.entries(merged).map(([action, definition]) => toCatalogAction(action, definition));
}

/**
 * Tag do catálogo abaixo de `CUSTOM_TAG_MIN` sem Model registrado não vira recurso, e as condições
 * dela nunca seriam avaliadas: o grant sozinho liberaria. Avisa em vez de engolir.
 */
function warnTagsWithoutModel(config: ResolvedPermissionsConfig, modelTags: Set<number>): void {
  const orfas = Object.keys(config.catalog)
    .map(Number)
    .filter((tag) => tag >= 0 && tag < CUSTOM_TAG_MIN && !modelTags.has(tag));
  if (orfas.length === 0) return;
  logger.warn(
    `[@mateusseiboth/ts-decorators] Tags do catálogo de permissões sem Model registrado (ignoradas): ${orfas.join(", ")}. ` +
      `Importe o Model antes de montar o catálogo, ou use uma tag custom (>= ${CUSTOM_TAG_MIN}).`,
  );
}

function build(config: ResolvedPermissionsConfig): CatalogResource[] {
  const models = discoverModels();
  const modelTags = new Set(models.map((model) => model.tag));
  warnTagsWithoutModel(config, modelTags);
  return [...models, ...discoverCustomTags(config, modelTags)].map((discovered) => {
    const resource: CatalogResource = {
      ...discovered,
      actions: resolveActions(discovered, config.catalog[discovered.tag]),
    };
    return { ...resource, ...config.describeResource(resource) };
  });
}

interface CatalogCache {
  /** A configuração que gerou o catálogo: outra configuração refaz. */
  config: ResolvedPermissionsConfig;
  resources: CatalogResource[];
  actions: Map<string, CatalogAction>;
}

let cache: CatalogCache | undefined;

const indexActions = (resources: CatalogResource[]): Map<string, CatalogAction> =>
  new Map(
    resources.flatMap((resource) =>
      resource.actions.map((entry) => [`${resource.tag}:${entry.action}`, entry] as const),
    ),
  );

function readCache(): CatalogCache {
  const config = requirePermissionsConfig();
  if (cache?.config === config) return cache;
  const resources = build(config);
  cache = { config, resources, actions: indexActions(resources) };
  return cache;
}

/**
 * Recursos, ações e condições, para a tela da matriz. `Extra` é o que o `describeResource` do app
 * soma a cada recurso.
 */
export function getPermissionCatalog<
  Extra extends object = Record<never, never>,
>(): (CatalogResource & Extra)[] {
  return readCache().resources as (CatalogResource & Extra)[];
}

/** Definição de `"tag:action"`: traz as `conditions` que o motor ABAC avalia. */
export function getActionDef(tag: number, action: ActionKey): CatalogAction | undefined {
  return readCache().actions.get(`${tag}:${action}`);
}

/** Invalida a memoização: depois de registrar Models tardiamente, e nos testes. */
export function resetCatalogCache(): void {
  cache = undefined;
}

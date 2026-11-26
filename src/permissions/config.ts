/**
 * Configuração das permissões, injetada pelo app uma vez no bootstrap. Quem decide lê daqui NA
 * CHAMADA: a ordem dos imports não importa, e o decorator declarado antes do bootstrap funciona.
 */
import { getHandlerContext } from "../handlers/context";
import { DEFAULT_PERMISSION_MESSAGES } from "./constants";
import { PermissionDeniedError } from "./PermissionDeniedError";
import type {
  CatalogAugmentation,
  CatalogResource,
  OutsideRequestPolicy,
  PermissionMessages,
  PermissionSubject,
  PermissionsConfig,
} from "./types";

/** A configuração com os padrões aplicados: é o que o resto do módulo lê. */
export interface ResolvedPermissionsConfig {
  catalog: CatalogAugmentation;
  resolveSubject: (ctx: unknown, tag: number) => PermissionSubject | undefined;
  createForbiddenError: (message: string) => Error;
  getContext: () => unknown;
  isSameEntity?: (ctx: unknown) => boolean;
  describeResource: (resource: CatalogResource) => object;
  messages: PermissionMessages;
  isAllowedOutsideRequest: boolean;
  authorizeOutsideRequest: OutsideRequestPolicy;
}

const NOT_CONFIGURED =
  "[@mateusseiboth/ts-decorators] Permissões não configuradas. Chame configurePermissions() no bootstrap.";

const createPermissionDenied = (message: string): Error => new PermissionDeniedError(message);

const describeNothing = (): object => ({});

let current: ResolvedPermissionsConfig | undefined;

const mergeMessages = (input: PermissionsConfig["messages"]): PermissionMessages => ({
  ...DEFAULT_PERMISSION_MESSAGES,
  ...input,
  actionDenied: { ...DEFAULT_PERMISSION_MESSAGES.actionDenied, ...input?.actionDenied },
});

/** Liga as permissões. Chamar de novo troca a configuração e refaz o catálogo. */
export function configurePermissions<Ctx, Extra extends object = Record<never, never>>(
  config: PermissionsConfig<Ctx, Extra>,
): void {
  current = {
    catalog: config.catalog,
    resolveSubject: config.resolveSubject as ResolvedPermissionsConfig["resolveSubject"],
    createForbiddenError: config.createForbiddenError ?? createPermissionDenied,
    getContext: config.getContext ?? getHandlerContext,
    isSameEntity: config.isSameEntity as ResolvedPermissionsConfig["isSameEntity"],
    describeResource: config.describeResource ?? describeNothing,
    messages: mergeMessages(config.messages),
    isAllowedOutsideRequest: config.isAllowedOutsideRequest ?? false,
    authorizeOutsideRequest: config.authorizeOutsideRequest ?? "allow",
  };
}

/** Desliga as permissões (testes): a próxima checagem lança até o próximo `configurePermissions`. */
export function resetPermissions(): void {
  current = undefined;
}

/** Não configurado é erro de programação: falha fechada, com o que fazer. */
export function requirePermissionsConfig(): ResolvedPermissionsConfig {
  if (!current) throw new Error(NOT_CONFIGURED);
  return current;
}

/**
 * @RequiresPermission(key, check | options): autoriza `"tag:action"` ANTES de rodar o método.
 *
 * Lança o erro de negação configurado (o errorHandler responde 403). O substituto é async: aceita
 * `check` assíncrono e, combinado com a transação do app, roda dentro dela. A configuração é lida
 * na CHAMADA, não na decoração.
 *
 *   @RequiresPermission("1:enviar-boas-vindas")
 *   async enqueueWelcome(id: string) {}
 *
 *   @RequiresPermission("1:trocar-avatar", { resource: ([id]) => ({ ownerId: String(id) }) })
 *   async updateAvatar(id: string) {}
 *
 *   @RequiresPermission("1:enviar-boas-vindas", async ({ args }) => isAtiva(args[0]))
 *   async enqueueWelcome(id: string) {}
 */
import { makeMethodDecorator } from "../decorators/_method";
import { authorize } from "./authorize";
import type { PermissionCheck, RequiresPermissionOptions } from "./types";

/** 2º argumento: a função de checagem (atalho) ou o objeto de opções. */
const normalizeOptions = (
  arg: PermissionCheck | RequiresPermissionOptions | undefined,
): RequiresPermissionOptions => (typeof arg === "function" ? { check: arg } : (arg ?? {}));

export function RequiresPermission(
  key: string,
  options?: PermissionCheck | RequiresPermissionOptions,
) {
  const { resource, check, bypass } = normalizeOptions(options);

  return makeMethodDecorator("RequiresPermission", (original) => {
    const substituto = async function (this: unknown, ...args: unknown[]) {
      await authorize(key, { resource: resource?.(args), check, bypass, args });
      return original.apply(this, args);
    };
    // O nome do método segue no substituto: log, pilha e decorators de classe leem por ele.
    Object.defineProperty(substituto, "name", { value: original.name, configurable: true });
    return substituto;
  });
}

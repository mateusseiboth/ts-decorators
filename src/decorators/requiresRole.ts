/**
 * @RequiresRole(roles) — autorização por papel em métodos de Controller (req, res).
 *
 * Bloqueia (403) quando o usuário não possui nenhum dos papéis exigidos. A forma
 * de extrair os papéis do request é configurável; o default lê de
 * `res.locals.user.roles` / `req.user.roles`.
 *
 * Uso:
 *   @RequiresRole("admin")
 *   async remove(req, res) { ... }
 *
 *   @RequiresRole(["admin", "fiscal"])
 *   async aprovar(req, res) { ... }
 */

import {makeMethodDecorator} from "./_method";

export interface RequiresRoleOptions {
  /** Mensagem retornada no 403. */
  message?: string;
  /** Extrai os papéis do usuário a partir de (req, res). */
  rolesExtractor?: (req: any, res: any) => string[];
}

const DEFAULT_EXTRACTOR = (req: any, res: any): string[] => {
  const roles = res?.locals?.user?.roles ?? req?.user?.roles ?? res?.locals?.roles ?? [];
  return Array.isArray(roles) ? roles.map(String) : [String(roles)];
};

export function RequiresRole(roles: string | string[], options?: RequiresRoleOptions) {
  const required = (Array.isArray(roles) ? roles : [roles]).map(String);
  const message = options?.message ?? "Acesso negado: papel insuficiente.";
  const extractor = options?.rolesExtractor ?? DEFAULT_EXTRACTOR;

  return makeMethodDecorator("RequiresRole", (original) => {
    return async function (this: any, req: any, res: any, ...rest: any[]) {
      // Só age quando há (req, res) do Express; caso contrário, passa direto.
      if (!req || !res?.status) {
        return original.call(this, req, res, ...rest);
      }

      const userRoles = extractor(req, res);
      const allowed = required.some((role) => userRoles.includes(role));

      if (!allowed) {
        return res.status(403).json({message, code: "FORBIDDEN", requiredRoles: required});
      }

      return original.call(this, req, res, ...rest);
    };
  });
}

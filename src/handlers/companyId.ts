/**
 * Injeção da estratégia de company id (multi-tenant / row-level security).
 *
 * Por padrão o pacote executa `SET LOCAL "my.company_id" = <id>` no início de
 * cada transação. Projetos que usam outra convenção (outro nome de variável,
 * outro banco, uma stored procedure, um schema por tenant, ...) podem trocar a
 * implementação uma única vez no bootstrap — igual ao `setPrismaClient`.
 *
 * ```ts
 * import { setCompanyIdInjector } from "@mateusseiboth/ts-decorators";
 *
 * setCompanyIdInjector(async (tx, companyId) => {
 *   await tx.$executeRawUnsafe(`SELECT set_config('app.tenant', $1, true)`, companyId);
 * });
 * ```
 *
 * Para desligar a injeção: `setCompanyIdInjector(noopCompanyIdInjector)`.
 * Para voltar ao padrão do pacote: `resetCompanyIdInjector()`.
 */

/** Estratégia executada no início de cada transação. */
export type CompanyIdInjector = (tx: any, companyId: string) => void | Promise<void> | any;

/** Implementação padrão do pacote: RLS via `SET LOCAL "my.company_id"`. */
export const defaultCompanyIdInjector: CompanyIdInjector = (tx: any, companyId: string) => {
  console.log("[@mateusseiboth/ts-commons] Transaction started for company ID:", companyId);
  return tx.$executeRawUnsafe(`SET LOCAL "my.company_id" = ${Number(companyId)}`);
};

/** Estratégia vazia: não injeta nada na transação. */
export const noopCompanyIdInjector: CompanyIdInjector = () => undefined;

let _companyIdInjector: CompanyIdInjector = defaultCompanyIdInjector;

/** Substitui a estratégia global usada por `addCompanyIdToTransaction`. */
export function setCompanyIdInjector(injector: CompanyIdInjector): void {
  if (typeof injector !== "function") {
    throw new Error("[@mateusseiboth/ts-commons] setCompanyIdInjector espera uma função (tx, companyId) => void | Promise<void>.");
  }
  _companyIdInjector = injector;
}

export function getCompanyIdInjector(): CompanyIdInjector {
  return _companyIdInjector;
}

/** Restaura a estratégia padrão do pacote. */
export function resetCompanyIdInjector(): void {
  _companyIdInjector = defaultCompanyIdInjector;
}

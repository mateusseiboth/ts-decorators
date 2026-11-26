/**
 * Injeção da estratégia de company id (multi-tenant / row-level security).
 *
 * Por padrão o pacote executa `SELECT set_config('my.company_id', $1, true)` no início de cada
 * transação: o mesmo efeito do `SET LOCAL "my.company_id"`, mas com o id como PARÂMETRO (o
 * `SET` não aceita parâmetro, e colar o id no texto abre espaço para injeção de SQL). Serve para
 * id numérico ou UUID, na transação do Prisma 7 (`$executeRawUnsafe`) ou do Prisma 8
 * (`execute(plan)`, com `configurePrisma8` no bootstrap).
 *
 * Projetos que usam outra convenção (outro nome de variável, outro banco, uma stored
 * procedure, um schema por tenant, ...) trocam a implementação uma única vez no bootstrap,
 * igual ao `setPrismaClient`:
 *
 * ```ts
 * import { setCompanyIdInjector } from "@mateusseiboth/ts-decorators";
 *
 * setCompanyIdInjector(async (tx, companyId) => {
 *   await tx.$executeRawUnsafe(`SELECT set_config('app.tenant', $1, true)`, String(companyId));
 * });
 * ```
 *
 * Para desligar a injeção: `setCompanyIdInjector(noopCompanyIdInjector)`.
 * Para voltar ao padrão do pacote: `resetCompanyIdInjector()`.
 */
import { logger } from "../functions/logger";
import { isPrisma7Tx, isPrisma8Tx, rawParamStatementPlan, type Prisma8Tx } from "../prisma8/client";

/** Id do tenant: número (legado) ou texto (UUID). */
export type CompanyId = string | number;

/** Estratégia executada no início de cada transação. */
export type CompanyIdInjector = (tx: any, companyId: CompanyId) => void | Promise<void> | any;

type Prisma7RawTx = { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown> };

type SetCompanyId = (tx: any, id: string) => unknown;

/** Uma forma de transação → como fixar o tenant nela, sempre com o id parametrizado. */
const SET_COMPANY_ID_BY_TX: Array<[(tx: unknown) => boolean, SetCompanyId]> = [
  [
    isPrisma7Tx,
    (tx: Prisma7RawTx, id) =>
      tx.$executeRawUnsafe("SELECT set_config('my.company_id', $1, true)", id),
  ],
  [
    isPrisma8Tx,
    (tx: Prisma8Tx, id) =>
      tx.execute(rawParamStatementPlan`SELECT set_config('my.company_id', ${id}, true)`),
  ],
];

/** Implementação padrão do pacote: RLS via `set_config('my.company_id', $1, true)`. */
export const defaultCompanyIdInjector: CompanyIdInjector = async (tx, companyId) => {
  const setCompanyId = SET_COMPANY_ID_BY_TX.find(([matches]) => matches(tx))?.[1];
  if (!setCompanyId) {
    throw new Error(
      "[@mateusseiboth/ts-decorators] Objeto não é uma transação do Prisma 7 nem do Prisma 8.",
    );
  }
  logger.debug("[@mateusseiboth/ts-decorators] Transaction started for company ID:", companyId);
  // Texto, não número: UUID passa intacto e o id numérico grava o mesmo "42" do SET LOCAL.
  return setCompanyId(tx, String(companyId));
};

/**
 * Injetores que leem o tenant do CONTEXTO (as GUCs) e não do company id: rodam em toda transação,
 * mesmo sem `res.locals.entity` (o super admin, por exemplo).
 */
const _contextuais = new WeakSet<CompanyIdInjector>();

/** Marca o injetor como contextual: o `Transactional` chama mesmo sem company id. */
export function markContextualInjector<T extends CompanyIdInjector>(injector: T): T {
  _contextuais.add(injector);
  return injector;
}

export function isContextualInjector(injector: unknown): boolean {
  return typeof injector === "function" && _contextuais.has(injector as CompanyIdInjector);
}

/** Estratégia vazia: não injeta nada na transação. */
export const noopCompanyIdInjector: CompanyIdInjector = () => undefined;

let _companyIdInjector: CompanyIdInjector = defaultCompanyIdInjector;

/** Substitui a estratégia global usada por `addCompanyIdToTransaction`. */
export function setCompanyIdInjector(injector: CompanyIdInjector): void {
  if (typeof injector !== "function") {
    throw new Error(
      "[@mateusseiboth/ts-decorators] setCompanyIdInjector espera uma função (tx, companyId) => void | Promise<void>.",
    );
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

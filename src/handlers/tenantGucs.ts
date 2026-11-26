/**
 * RLS por várias GUCs: cada transação recebe um conjunto de `set_config(nome, valor, true)` lido do
 * contexto da requisição (conta, academia, rede, super admin...), em vez de um `company_id` só.
 * Nomes e valores vão como PARÂMETROS, num comando só, no Prisma 7 e no Prisma 8.
 *
 * ```ts
 * configureTenantGucs((ctx) => ({
 *   "app.conta_id": ctx?.contaId,
 *   "app.academia_id": ctx?.academiaId,
 *   "app.is_super_admin": ctx?.superAdmin === true,
 * }));
 * ```
 *
 * `configureTenantGucs` troca o injetor do `addCompanyIdToTransaction` (e com ele o
 * `Transactional`, o `@TransactionalClass` e o `withTransaction`) e o escopo do tenant das chaves
 * de cache, que passa a ser o conjunto inteiro das GUCs.
 */
import { stableStringify } from "../functions/object";
import { isPrisma7Tx, isPrisma8Tx, rawParamStatementPlan, type Prisma8Tx } from "../prisma8/client";
import { resetCompanyIdInjector, setCompanyIdInjector, type CompanyIdInjector } from "./companyId";
import {
  getHandlerContext,
  resetTenantScope,
  setTenantScope,
  type HandlerContext,
} from "./context";

/** Valor de cada GUC: `null` limpa (texto vazio); `undefined` fica de fora. */
export type TransactionGucValue = string | number | boolean | bigint | null | undefined;
export type TransactionGucs = Record<string, TransactionGucValue>;

/** As GUCs da requisição atual, a partir do contexto. */
export type TransactionGucsResolver = (ctx: HandlerContext | undefined) => TransactionGucs;

/** `prefixo.nome`, como o Postgres exige para variável de usuário. */
const NOME_DE_GUC = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

const requireNomeDeGuc = (nome: string): void => {
  if (NOME_DE_GUC.test(nome)) return;
  throw new TypeError(
    `[@mateusseiboth/ts-decorators] GUC "${nome}" fora do padrão prefixo.nome (ex.: app.conta_id).`,
  );
};

type Par = [string, string];

/** Os pares `[nome, valor em texto]` que vão ao banco. */
const buildPares = (gucs: TransactionGucs): Par[] =>
  Object.entries(gucs)
    .filter(([, valor]) => valor !== undefined)
    .map(([nome, valor]): Par => {
      requireNomeDeGuc(nome);
      return [nome, valor === null ? "" : String(valor)];
    });

type AplicarPares = (tx: any, pares: Par[]) => unknown;

const DOLAR = "$";

const buildSqlPrisma7 = (pares: Par[]): string =>
  pares
    .map((_, indice) => `set_config(${DOLAR}${indice * 2 + 1}, ${DOLAR}${indice * 2 + 2}, true)`)
    .join(", ");

const applyPrisma7: AplicarPares = (tx, pares) =>
  tx.$executeRawUnsafe(`SELECT ${buildSqlPrisma7(pares)}`, ...pares.flat());

/** Template com um `set_config(?, ?, true)` por par, para o `db.raw.sql` parametrizar. */
const buildTemplate = (quantidade: number): TemplateStringsArray => {
  const strings = ["SELECT set_config("];
  for (let indice = 0; indice < quantidade; indice++) {
    strings.push(", ");
    strings.push(indice === quantidade - 1 ? ", true)" : ", true), set_config(");
  }
  return Object.assign(strings, { raw: [...strings] }) as unknown as TemplateStringsArray;
};

const applyPrisma8: AplicarPares = (tx: Prisma8Tx, pares) =>
  tx.execute(rawParamStatementPlan(buildTemplate(pares.length), ...pares.flat()));

const APLICADORES: Array<[(tx: unknown) => boolean, AplicarPares]> = [
  [isPrisma7Tx, applyPrisma7],
  [isPrisma8Tx, applyPrisma8],
];

/** Fixa as GUCs na transação, num comando só e parametrizado. Sem GUC nenhuma, não vai ao banco. */
export async function applyTransactionGucs(tx: unknown, gucs: TransactionGucs): Promise<void> {
  const pares = buildPares(gucs);
  if (!pares.length) return;
  const aplicar = APLICADORES.find(([matches]) => matches(tx))?.[1];
  if (!aplicar) {
    throw new Error(
      "[@mateusseiboth/ts-decorators] Objeto não é uma transação do Prisma 7 nem do Prisma 8.",
    );
  }
  await aplicar(tx, pares);
}

/** Injetor para o `setCompanyIdInjector`: ignora o company id e fixa as GUCs do contexto. */
export function createGucsInjector(resolve: TransactionGucsResolver): CompanyIdInjector {
  return function gucsInjector(tx) {
    return applyTransactionGucs(tx, resolve(getHandlerContext()));
  };
}

/** O escopo do tenant: as GUCs definidas, em ordem estável. */
const buildScope = (resolve: TransactionGucsResolver) => (): string =>
  stableStringify(
    Object.fromEntries(
      Object.entries(resolve(getHandlerContext())).filter(([, valor]) => valor !== undefined),
    ),
  );

/** Liga as GUCs por requisição: injetor das transações e escopo do tenant nas chaves de cache. */
export function configureTenantGucs(resolve: TransactionGucsResolver): void {
  setCompanyIdInjector(createGucsInjector(resolve));
  setTenantScope(buildScope(resolve));
}

/** Volta ao `my.company_id` padrão e ao escopo pela `entity`. */
export function resetTenantGucs(): void {
  resetCompanyIdInjector();
  resetTenantScope();
}

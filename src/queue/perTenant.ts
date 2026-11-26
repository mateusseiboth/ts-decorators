/**
 * Concorrência por tenant (`perTenant` do @Processor): no máximo N jobs do mesmo tenant em
 * execução, e a vaga livre vai primeiro para o tenant com menos jobs rodando.
 *
 * A escolha é a mesma nos dois adapters: o SQLite faz na consulta, o de memória (e a fila, para o
 * adapter sem `findPendingPerTenant`) faz aqui, em `selectPerTenant`.
 */

import { REGRA, requireOpcoes, type RegraDaOpcao } from "../decorators/_opcoes";
import { hasTenant, type HandlerContext } from "../handlers/context";
import type { QueueJob } from "./adapter";

type Tenant = NonNullable<HandlerContext["entity"]>;

export interface PerTenantOptions {
  /** Máximo de jobs do mesmo tenant em execução ao mesmo tempo. Inteiro maior ou igual a 1. */
  concurrency: number;
  /**
   * O tenant do job. Default: o primeiro que existir entre `payload.tenant`, `payload.ctx.tenant`,
   * `payload.ctx.entity`, `payload.companyId` e `payload.user.entidade` (o `ReportUser`). Sem tenant (`undefined`, `null`, `0`, texto vazio), o job não tem
   * limite por tenant.
   */
  key?: (payload: any) => string | number | null | undefined;
}

/** O `perTenant` pronto para a fila: limite validado e o tenant de cada job em texto. */
export interface PerTenantConfig {
  concurrency: number;
  /** O tenant como o adapter grava e compara. `""` quando o job não tem tenant. */
  tenantOf: (payload: any) => string;
  key: (payload: any) => unknown;
}

/** Valor gravado no job sem tenant: distingue "sem tenant" de "ainda não lida". */
export const WITHOUT_TENANT = "";

/** Onde os apps costumam pôr o tenant no payload, na ordem em que é procurado. */
const CAMINHOS_DO_TENANT: ReadonlyArray<(payload: any) => unknown> = [
  (payload) => payload?.tenant,
  (payload) => payload?.ctx?.tenant,
  (payload) => payload?.ctx?.entity,
  (payload) => payload?.companyId,
  (payload) => payload?.user?.entidade,
];

/** O tenant do payload nos formatos que os apps usam, ou `undefined`. */
export const findTenantDoPayload = (payload: unknown): Tenant | undefined =>
  CAMINHOS_DO_TENANT.map((caminho) => caminho(payload)).find(hasTenant);

const buildTenantOf =
  (key: (payload: any) => unknown) =>
  (payload: any): string => {
    const tenant = key(payload);
    return hasTenant(tenant) ? String(tenant) : WITHOUT_TENANT;
  };

type OpcoesValidadas = { "perTenant.concurrency": unknown };

const REGRAS: readonly RegraDaOpcao<OpcoesValidadas>[] = [
  { campo: "perTenant.concurrency", ...REGRA.INTEIRO_POSITIVO },
];

/** Lança na configuração, e não no meio do consumo, quando o `perTenant` não serve. */
export function requirePerTenant(
  origem: string,
  options: { perTenant?: PerTenantOptions; keyOf?: unknown },
): void {
  if (!options.perTenant) return;
  if (options.keyOf) {
    // Os dois limitam por chave: juntos, não haveria uma regra só para a vaga.
    throw new TypeError(
      `[@mateusseiboth/ts-decorators] ${origem}: use perTenant ou keyOf, não os dois.`,
    );
  }
  requireOpcoes(origem, { "perTenant.concurrency": options.perTenant.concurrency }, REGRAS);
}

export function buildPerTenant(options: PerTenantOptions): PerTenantConfig {
  const key = options.key ?? findTenantDoPayload;
  return {
    concurrency: options.concurrency,
    tenantOf: buildTenantOf(key),
    key,
  };
}

/** Quantos jobs de cada tenant há na lista (os em `processing`, para o limite). */
export function countPerTenant(jobs: ReadonlyArray<QueueJob>): Map<string, number> {
  const contagem = new Map<string, number>();
  for (const job of jobs) {
    const tenant = job.tenant ?? WITHOUT_TENANT;
    contagem.set(tenant, (contagem.get(tenant) ?? 0) + 1);
  }
  return contagem;
}

export interface SelectPerTenantOptions {
  /** Quantos jobs devolver, no máximo. */
  limit: number;
  /** Máximo de jobs do mesmo tenant em `processing`. */
  concurrency: number;
}

interface Candidato {
  job: QueueJob;
  /** Quantos jobs do tenant estariam rodando com este: 1 para o primeiro do tenant ocioso. */
  vez: number;
}

/**
 * Os próximos jobs a rodar, intercalando os tenants.
 *
 * A `vez` do job é quantos jobs do tenant dele estariam rodando junto com ele. Passa só quem cabe
 * no limite, e a vez menor vai primeiro: o primeiro job de um tenant ocioso passa na frente do
 * segundo de um tenant que já está rodando. Na mesma vez, o mais antigo primeiro. O job sem
 * tenant tem sempre vez 1.
 *
 * `pendentes` chega do mais antigo para o mais novo, com a `tenant` de cada job preenchida.
 */
export function selectPerTenant(
  pendentes: ReadonlyArray<QueueJob>,
  emProcessamento: ReadonlyMap<string, number>,
  options: SelectPerTenantOptions,
): QueueJob[] {
  const ordemDoTenant = new Map<string, number>();
  const candidatos: Candidato[] = pendentes.map((job) => {
    const tenant = job.tenant ?? WITHOUT_TENANT;
    const ordem = (ordemDoTenant.get(tenant) ?? 0) + 1;
    ordemDoTenant.set(tenant, ordem);
    const vez = tenant === WITHOUT_TENANT ? 1 : ordem + (emProcessamento.get(tenant) ?? 0);
    return { job, vez };
  });
  return candidatos
    .filter((candidato) => candidato.vez <= options.concurrency)
    .sort((a, b) => a.vez - b.vez || a.job.createdAt - b.job.createdAt)
    .slice(0, options.limit)
    .map((candidato) => candidato.job);
}

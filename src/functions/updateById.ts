/**
 * UPDATE de um registro pelo id, com a trava otimista do DAO quando ela está ligada
 * (`@DAOFor(tag, { optimisticLock: true })`). É o update do `BaseDAO` dos apps: Prisma 7 (o
 * delegate, `tx.imovel`) e Prisma 8 (a coleção, `tx.orm.public.Imovel`).
 *
 * A versão é o `updated_at` que o cliente carregou. Com ela, o UPDATE é condicional
 * (`where id AND updated_at = versão`) numa instrução só: ler e depois gravar deixaria entre as
 * duas exatamente a gravação concorrente que se quer pegar.
 *
 * - Casou: grava, e a coluna da versão recebe o instante da gravação.
 * - Não casou e o registro existe: `OptimisticLockError` (409), contado em
 *   `app.optimistic_lock.conflict` com o model (`db.collection.name`).
 * - Não casou e o registro não existe: `null`, e o app responde o 404 de sempre.
 * - Sem versão no pedido: atualiza sem conferir. Recusar quebraria o cliente que ainda não
 *   manda a versão; ligar a trava num DAO não pode derrubar as telas que já existem.
 */
import type { Request } from "express";

import { getOptimisticLock, type OptimisticLock } from "../decorators/getModel";
import { ClientError } from "../errors/commons";
import { OptimisticLockError } from "../errors/optimisticLock";
import { METRICA } from "../observability/catalog";
import { incrementMetric } from "../observability/metrics";
import { collectionMeta, type OrmCollection } from "../prisma8/query";
import { decodeRowsForCollection, encodeRowForCollection } from "../prisma8/temporal";
import { applyWhere } from "../prisma8/where";

type Row = Record<string, unknown>;

export interface UpdateByIdOptions {
  /** O DAO (classe ou instância). A trava vale quando o `@DAOFor` dele a liga. */
  dao?: object;
  /** A versão que o cliente carregou (o `If-Match`). Default: a coluna da versão em `data`. */
  version?: unknown;
}

/** O que o `updateById` usa do delegate do Prisma 7. */
interface Prisma7Delegate {
  updateMany(args: { where: Row; data: Row }): Promise<{ count: number }>;
  findFirst(args: { where: Row }): Promise<unknown>;
}

/** O que o `updateById` usa da coleção do Prisma 8. */
interface Prisma8Collection {
  where: (...args: any[]) => any;
  update: (data: Row) => Promise<Row | null>;
  first: () => Promise<unknown>;
}

/** Os dois passos que mudam entre o Prisma 7 e o 8. */
interface Gravador {
  update(where: Row, data: Row): Promise<Row | null>;
  find(id: unknown): Promise<Row | null>;
}

const isPrisma7Delegate = (target: unknown): target is Prisma7Delegate =>
  typeof (target as Prisma7Delegate).updateMany === "function";

// O Prisma 7 devolve a contagem no `updateMany`: a linha alterada é relida. O payload e a
// releitura passam pelo mesmo caminho único do Prisma 8 (`@Field` normaliza, cifra e decifra).
const buildGravador7 = (delegate: Prisma7Delegate): Gravador => {
  const find = async (id: unknown) =>
    decodeRowsForCollection(delegate, (await delegate.findFirst({ where: { id } })) as Row | null);
  return {
    find,
    async update(where, data) {
      const { count } = await delegate.updateMany({
        where,
        data: encodeRowForCollection(delegate, data),
      });
      return count > 0 ? find(where.id) : null;
    },
  };
};

const withoutUndefined = (data: Row): Row =>
  Object.fromEntries(Object.entries(data).filter(([, valor]) => valor !== undefined));

// O `update()` da coleção do Prisma 8 devolve a linha alterada, ou `null` quando nada casou.
const buildGravador8 = (collection: Prisma8Collection): Gravador => ({
  update: (where, data) =>
    applyWhere(collection, where).update(
      encodeRowForCollection(collection, withoutUndefined(data)),
    ),
  find: async (id) => (await applyWhere(collection, { id }).first()) as Row | null,
});

/** O pedido de UPDATE: o filtro, o payload e se há versão a conferir. */
interface Plano {
  where: Row;
  data: Row;
  hasVersao: boolean;
}

const isVersaoAusente = (version: unknown) =>
  version === undefined || version === null || version === "";

/** `"2026-11-05T14:30:00.123Z"` e `W/"..."` (ETag do `If-Match`) viram o texto da data. */
const stripEtag = (version: unknown) =>
  typeof version === "string" ? version.replace(/^W\//, "").replace(/^"(.*)"$/, "$1") : version;

const parseVersao = (version: unknown): Date => {
  const instante = new Date(stripEtag(version) as string | number | Date);
  if (Number.isNaN(instante.getTime())) {
    throw new ClientError("A versão do registro é inválida. Recarregue a tela e tente de novo.");
  }
  return instante;
};

/**
 * A versão chega com milissegundos; a coluna pode guardar microssegundos. O filtro é a faixa do
 * milissegundo, `[versão, versão + 1 ms)`: a igualdade exata nunca casaria com a coluna mais fina.
 */
const buildFiltroDaVersao = (instante: Date) => ({
  gte: instante,
  lt: new Date(instante.getTime() + 1),
});

function buildPlanoComTrava(id: unknown, data: Row, lock: OptimisticLock, version: unknown): Plano {
  // A versão que o cliente devolveu nunca volta para o banco: ela é o filtro, não o valor.
  const { [lock.column]: versaoDoCorpo, ...resto } = data;
  const versao = version ?? versaoDoCorpo;
  const payload = { ...resto, [lock.column]: new Date() };
  if (isVersaoAusente(versao)) return { where: { id }, data: payload, hasVersao: false };
  return {
    where: { id, [lock.column]: buildFiltroDaVersao(parseVersao(versao)) },
    data: payload,
    hasVersao: true,
  };
}

const buildPlano = (id: unknown, data: Row, options: UpdateByIdOptions): Plano => {
  const lock = getOptimisticLock(options.dao);
  if (!lock) return { where: { id }, data, hasVersao: false };
  return buildPlanoComTrava(id, data, lock, options.version);
};

/** O model do conflito: o da coleção do Prisma 8, senão o Model do `@DAOFor`. */
const readModel = (target: unknown, dao: unknown): string | undefined => {
  const classe = typeof dao === "function" ? dao : (dao as object | undefined)?.constructor;
  return (
    collectionMeta(target as OrmCollection).modelName ??
    (classe as { model?: { name?: string } } | undefined)?.model?.name
  );
};

const countConflito = (target: unknown, options: UpdateByIdOptions): void => {
  const model = readModel(target, options.dao);
  incrementMetric({
    ...METRICA.OPTIMISTIC_LOCK_CONFLICT,
    attributes: model ? { "db.collection.name": model } : {},
  });
};

/** Nada casou: com versão, o registro existir quer dizer que outro gravou antes. */
async function requireInexistente(
  gravador: Gravador,
  id: unknown,
  plano: Plano,
  onConflito: () => void,
): Promise<null> {
  if (!plano.hasVersao) return null;
  const atual = await gravador.find(id);
  if (!atual) return null;
  onConflito();
  throw new OptimisticLockError(id);
}

export async function updateById(
  target: Prisma7Delegate | Prisma8Collection,
  id: unknown,
  data: Row,
  options: UpdateByIdOptions = {},
): Promise<Row | null> {
  const plano = buildPlano(id, data, options);
  const gravador = isPrisma7Delegate(target) ? buildGravador7(target) : buildGravador8(target);
  const row = await gravador.update(plano.where, plano.data);
  return row ?? requireInexistente(gravador, id, plano, () => countConflito(target, options));
}

/**
 * A versão do cabeçalho `If-Match`, sem as aspas e sem o `W/` do ETag. `*` (qualquer versão)
 * e a ausência do cabeçalho devolvem `undefined`: o update não confere.
 */
export function readIfMatch(req: Request): string | undefined {
  const valor = req.header("if-match")?.trim();
  if (!valor || valor === "*") return undefined;
  return stripEtag(valor) as string;
}

/**
 * @Auditable - Decorator para registrar modificações (e, se pedido, leituras) de registros.
 *
 * Intercepta métodos de escrita (create, update, deleteById) e grava um log
 * de auditoria na tabela `audit_log` após a operação ser concluída com sucesso.
 * Com `read`, também registra QUEM LEU (LGPD): ação `READ`, sem o conteúdo lido.
 *
 * Uso:
 *   @Auditable
 *   @Auditable({ read: true })                 // + leitura do getById
 *   @Auditable({ read: ["getById", "get"] })   // + leitura da listagem
 *   class MeuController extends BaseController { ... }
 *
 * O decorator espera que o controller tenha:
 *   - `this.DAO.tx` (Prisma TransactionClient) para gravar a escrita no banco
 *   - Os métodos recebam (req: Request, res: Response) como padrão Express
 *
 */

import type { Request, Response } from "express";

import { logger } from "../functions/logger";
import { markBodyCapture } from "../observability/bodyCapture";
import { isPrisma8Tx, ormCollection } from "../prisma8/client";
import { insertAuditLog } from "./_auditLogSql";
import { enqueueAuditRead, flushAuditReads } from "./_auditReads";
import { wrapMetodosDaClasse } from "./_method";
import { isDecoratorContext, warnLegacy } from "./_proxy";

export { flushAuditReads };

export interface AuditEntry {
  action: "CREATE" | "UPDATE" | "DELETE" | "READ";
  entity: string;
  entityId: string | null;
  userId: string;
  entidade: number;
  before: any;
  after: any;
  timestamp: Date;
  method: string;
  ip: string;
}

type AuditStorageAdapter = (entry: AuditEntry, tx?: any) => Promise<void>;

/**
 * Destino padrão: a escrita vai na transação da requisição (rollback desfaz o registro junto com a
 * escrita); a leitura vai para o lote, que grava numa transação própria.
 */
const defaultStorage: AuditStorageAdapter = async (entry: AuditEntry, tx?: any) => {
  if (entry.action === "READ") return enqueueAuditRead(entry);
  if (!tx) return;
  try {
    await insertAuditLog(tx, entry);
  } catch (err) {
    // Auditoria não deve quebrar a operação principal
    logger.error("[@mateusseiboth/ts-decorators] Auditable: Erro ao gravar audit_log:", err);
  }
};

// Configuração global do adapter de storage
let _storageAdapter: AuditStorageAdapter = defaultStorage;

export function setAuditStorage(adapter: AuditStorageAdapter) {
  _storageAdapter = adapter;
}

/** Volta para o destino padrão (testes). */
export function resetAuditStorage(): void {
  _storageAdapter = defaultStorage;
}

// Mapeamento de nomes de método → ação
const METHOD_ACTION_MAP: Record<string, Exclude<AuditEntry["action"], "READ">> = {
  create: "CREATE",
  update: "UPDATE",
  deleteById: "DELETE",
};

export interface AuditableOptions {
  /**
   * Busca o registro ANTES de alterar/apagar (um `findUnique` extra por
   * escrita) e guarda em `before`. Default: `true`, como sempre foi.
   *
   * DESLIGUE (`captureBefore: false`) para poupar essa consulta quando o corpo
   * da requisição já conta a história: o `after` diz o que mudou sem uma ida a
   * mais ao banco em cada UPDATE/DELETE.
   */
  captureBefore?: boolean;
  /**
   * Intercepta `res.json` para aproveitar o corpo da resposta como `after` e
   * descobrir o id de um CREATE. Default: `true` (custa só um closure).
   */
  captureResponse?: boolean;
  /**
   * Registra também a LEITURA (LGPD: quem consultou folha, salário, CPF). Default: `false`.
   *
   * `true` audita o `getById`. Uma lista nomeia os métodos: `["getById", "get"]` inclui a
   * listagem. A entrada tem ação `READ`, o id lido e quem leu, nunca o conteúdo: o log não pode
   * virar uma segunda cópia do dado pessoal. A listagem gera UMA entrada por requisição, com o
   * filtro (`req.query`) em `after`, e não uma por linha devolvida.
   */
  read?: boolean | string[];
}

const DEFAULT_AUDIT_OPTIONS: Required<AuditableOptions> = {
  captureBefore: true,
  captureResponse: true,
  read: false,
};

/** O que cada valor de `read` audita: `true` é o detalhe de um registro. */
const READ_METHODS_BY_FLAG: Record<"true" | "false", readonly string[]> = {
  true: ["getById"],
  false: [],
};

const readMethodsOf = (read: AuditableOptions["read"]): readonly string[] =>
  Array.isArray(read) ? read : READ_METHODS_BY_FLAG[String(read === true) as "true" | "false"];

function modelNameOf(instance: any, className: string): string {
  return (instance.constructor as any).modelName || className.replace("Controller", "");
}

async function readBeforePrisma7(tx: any, modelName: string, entityId: string): Promise<any> {
  const prismaModel = tx[modelName.charAt(0).toLowerCase() + modelName.slice(1)] ?? tx[modelName];
  if (!prismaModel?.findUnique) return null;
  return await prismaModel.findUnique({ where: { id: entityId } });
}

async function readBeforePrisma8(tx: any, modelName: string, entityId: string): Promise<any> {
  const collection = ormCollection(tx, modelName) as
    | { where?: (w: unknown) => { first(): Promise<unknown> } }
    | undefined;
  if (typeof collection?.where !== "function") return null;
  return await collection.where({ id: entityId }).first();
}

/** Estado anterior do registro — só quando explicitamente pedido. */
async function readBefore(
  instance: any,
  className: string,
  entityId: string | null,
  tx: any,
): Promise<any> {
  if (!entityId || !tx) return null;
  try {
    const modelName = modelNameOf(instance, className);
    const read = isPrisma8Tx(tx) ? readBeforePrisma8 : readBeforePrisma7;
    return await read(tx, modelName, entityId);
  } catch {
    // ignora se não conseguir buscar o estado anterior
    return null;
  }
}

/**
 * Decorator de classe. Envolve métodos de escrita com lógica de auditoria.
 *
 * Aceita as duas formas:
 *
 *   @Auditable                              // padrões
 *   @Auditable({ captureBefore: true })     // com opções
 */
export function Auditable<T extends { new (...args: any[]): any }>(
  constructor: T,
  context?: ClassDecoratorContext,
): T;
export function Auditable(
  options?: AuditableOptions,
): <T extends { new (...args: any[]): any }>(constructor: T, context?: ClassDecoratorContext) => T;
export function Auditable(...args: any[]): any {
  if (typeof args[0] === "function") {
    return applyAuditable(args[0], args[1], DEFAULT_AUDIT_OPTIONS);
  }
  const opts = { ...DEFAULT_AUDIT_OPTIONS, ...(args[0] as AuditableOptions | undefined) };
  return (constructor: any, context?: ClassDecoratorContext) =>
    applyAuditable(constructor, context, opts);
}

const MARCA_AUDITABLE = Symbol("ts-decorators:auditable");

/** Quem, de onde e em qual registro: o que a escrita e a leitura registram igual. */
function buildEntryBase(req: Request, res: Response, className: string, methodName: string) {
  return {
    entity: className.replace("Controller", ""),
    userId: res.locals?.userInfo?.id || "unknown",
    entidade: Number(res.locals?.entity || 0),
    timestamp: new Date(),
    method: `${className}.${methodName}`,
    ip: req.ip || req.socket?.remoteAddress || "unknown",
  };
}

/** Entrega sem esperar e sem deixar o destino derrubar quem chamou, nem lançando na hora. */
function dispatchEntry(entry: AuditEntry, tx?: any): void {
  void Promise.resolve()
    .then(() => _storageAdapter(entry, tx))
    .catch(() => {});
}

const hasKeys = (value: unknown): boolean =>
  !!value && typeof value === "object" && Object.keys(value).length > 0;

/**
 * A leitura registra o id lido e, na listagem, o filtro: nunca o corpo da resposta. Não intercepta
 * o `res.json` e não passa a transação: o registro é gravado mesmo que ela sofra rollback.
 */
function buildRead(className: string, methodName: string, original: Function): Function {
  return async function (this: any, req: Request, res: Response, ...rest: any[]) {
    const result = await original.call(this, req, res, ...rest);
    // Leitura recusada (404, 403...) não entregou dado nenhum.
    if (res.statusCode >= 400) return result;

    // No Express 5 o parâmetro pode chegar como lista (`/:id+`).
    const id: string | string[] | undefined = req.params?.id;
    const entityId = Array.isArray(id) ? id.join("/") : (id ?? null);
    const query = entityId === null && hasKeys(req.query) ? { query: req.query } : null;
    dispatchEntry({
      ...buildEntryBase(req, res, className, methodName),
      action: "READ",
      entityId,
      before: null,
      after: query,
    });
    return result;
  };
}

function buildWrite(
  className: string,
  methodName: string,
  action: Exclude<AuditEntry["action"], "READ">,
  original: Function,
  opts: Required<AuditableOptions>,
): Function {
  return async function (this: any, req: Request, res: Response, ...rest: any[]) {
    // Escrita auditada leva o corpo inteiro (credenciais mascaradas) para o span do `observeHttp`.
    markBodyCapture(req);
    const entityId = req.params?.id || this.data?.id || null;
    const tx = this.DAO?.tx;

    const before =
      opts.captureBefore && (action === "UPDATE" || action === "DELETE")
        ? await readBefore(this, className, entityId, tx)
        : null;

    // Intercepta res.json/res.end para capturar o resultado
    let capturedResponse: any = null;
    if (opts.captureResponse) {
      const originalJson = res.json.bind(res);
      res.json = function (body: any) {
        capturedResponse = body;
        return originalJson(body);
      };
    }

    const result = await original.call(this, req, res, ...rest);

    // Grava auditoria após sucesso (não-bloqueante para a resposta).
    // O que chegou no body já descreve a mudança — não precisa reler o banco.
    const after =
      action === "DELETE" ? null : (capturedResponse?.data ?? this.data ?? req.body ?? null);
    const finalEntityId = entityId || capturedResponse?.data?.id || capturedResponse?.id || null;

    dispatchEntry(
      {
        ...buildEntryBase(req, res, className, methodName),
        action,
        entityId: finalEntityId,
        before,
        after,
      },
      tx,
    );

    return result;
  };
}

function applyAuditable<T extends { new (...args: any[]): any }>(
  constructor: T,
  context: ClassDecoratorContext | undefined,
  opts: Required<AuditableOptions>,
): T {
  if (!context || !isDecoratorContext(context)) {
    warnLegacy("Auditable");
  }
  const className = constructor.name;
  const readMethods = readMethodsOf(opts.read);

  // A escrita vence: um método de escrita nomeado em `read` continua auditado como escrita.
  wrapMetodosDaClasse(constructor, MARCA_AUDITABLE, ({ name, original }) => {
    const action = METHOD_ACTION_MAP[name];
    if (action) return buildWrite(className, name, action, original, opts);
    if (readMethods.includes(name)) return buildRead(className, name, original);
    return undefined;
  });

  return constructor;
}

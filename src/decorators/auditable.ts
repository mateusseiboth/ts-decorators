/**
 * @Auditable - Decorator para registrar modificações em registros.
 *
 * Intercepta métodos de escrita (create, update, deleteById) e grava um log
 * de auditoria na tabela `audit_log` após a operação ser concluída com sucesso.
 *
 * Uso:
 *   @Auditable
 *   class MeuController extends BaseController { ... }
 *
 * O decorator espera que o controller tenha:
 *   - `this.DAO.tx` (Prisma TransactionClient) para gravar no banco
 *   - Os métodos recebam (req: Request, res: Response) como padrão Express
 *
 */

import type { Request, Response } from "express";

import { logger } from "../functions/logger";
import { isDecoratorContext, warnLegacy } from "./_proxy";

export interface AuditEntry {
  action: "CREATE" | "UPDATE" | "DELETE";
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

// Storage adapter padrão: grava via Prisma na tabela audit_log
const defaultStorage: AuditStorageAdapter = async (entry: AuditEntry, tx?: any) => {
  if (!tx) return;
  try {
    await tx.$executeRawUnsafe(
      `INSERT INTO "audit_log" ("action", "entity", "entity_id", "user_id", "entidade", "before", "after", "timestamp", "method", "ip")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
      entry.action,
      entry.entity,
      entry.entityId,
      entry.userId,
      entry.entidade,
      JSON.stringify(entry.before),
      JSON.stringify(entry.after),
      entry.timestamp,
      entry.method,
      entry.ip,
    );
  } catch (err) {
    // Auditoria não deve quebrar a operação principal
    logger.error("[@mateusseiboth/ts-commons] Auditable: Erro ao gravar audit_log:", err);
  }
};

// Configuração global do adapter de storage
let _storageAdapter: AuditStorageAdapter = defaultStorage;

export function setAuditStorage(adapter: AuditStorageAdapter) {
  _storageAdapter = adapter;
}

// Mapeamento de nomes de método → ação
const METHOD_ACTION_MAP: Record<string, AuditEntry["action"]> = {
  create: "CREATE",
  update: "UPDATE",
  deleteById: "DELETE",
};

export interface AuditableOptions {
  /**
   * Busca o registro ANTES de alterar/apagar (um `findUnique` extra por
   * escrita) e guarda em `before`. Default: `false`.
   *
   * O que mudou já está no corpo da requisição — `after` conta a história sem
   * uma ida a mais ao banco em cada UPDATE/DELETE. Ligue quando a auditoria
   * precisar do valor antigo campo a campo (exigência legal, diff em tela).
   */
  captureBefore?: boolean;
  /**
   * Intercepta `res.json` para aproveitar o corpo da resposta como `after` e
   * descobrir o id de um CREATE. Default: `true` (custa só um closure).
   */
  captureResponse?: boolean;
}

const DEFAULT_AUDIT_OPTIONS: Required<AuditableOptions> = {
  captureBefore: false,
  captureResponse: true,
};

/** Estado anterior do registro — só quando explicitamente pedido. */
async function readBefore(
  instance: any,
  className: string,
  entityId: string | null,
  tx: any,
): Promise<any> {
  if (!entityId || !tx) return null;
  try {
    const modelName =
      (instance.constructor as any).modelName || className.replace("Controller", "");
    const prismaModel = tx[modelName.charAt(0).toLowerCase() + modelName.slice(1)];
    if (!prismaModel?.findUnique) return null;
    return await prismaModel.findUnique({ where: { id: entityId } });
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

function applyAuditable<T extends { new (...args: any[]): any }>(
  constructor: T,
  context: ClassDecoratorContext | undefined,
  opts: Required<AuditableOptions>,
): T {
  if (!context || !isDecoratorContext(context)) {
    warnLegacy("Auditable");
  }
  const className = constructor.name;

  for (const methodName of Object.getOwnPropertyNames(constructor.prototype)) {
    if (methodName === "constructor") continue;

    const action = METHOD_ACTION_MAP[methodName];
    if (!action) continue;

    const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, methodName);
    if (!descriptor || typeof descriptor.value !== "function") continue;

    const originalMethod = descriptor.value;

    descriptor.value = async function (this: any, req: Request, res: Response, ...rest: any[]) {
      const entityId = req.params?.id || this.data?.id || null;
      const userId = res.locals?.userInfo?.id || "unknown";
      const entidade = Number(res.locals?.entity || 0);
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
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

      const result = await originalMethod.call(this, req, res, ...rest);

      // Grava auditoria após sucesso (não-bloqueante para a resposta).
      // O que chegou no body já descreve a mudança — não precisa reler o banco.
      const after =
        action === "DELETE" ? null : (capturedResponse?.data ?? this.data ?? req.body ?? null);
      const finalEntityId = entityId || capturedResponse?.data?.id || capturedResponse?.id || null;

      const entry: AuditEntry = {
        action,
        entity: className.replace("Controller", ""),
        entityId: finalEntityId,
        userId,
        entidade,
        before,
        after,
        timestamp: new Date(),
        method: `${className}.${methodName}`,
        ip,
      };

      // Fire and forget — não bloqueia a resposta
      _storageAdapter(entry, tx).catch(() => {});

      return result;
    };

    Object.defineProperty(constructor.prototype, methodName, descriptor);
  }

  return constructor;
}

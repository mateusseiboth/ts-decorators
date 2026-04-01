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

import type {Request, Response} from "express";
import {isDecoratorContext, warnLegacy} from "./_proxy";

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
    console.error("[@mateusseiboth/ts-commons] Auditable: Erro ao gravar audit_log:", err);
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

/**
 * Decorator de classe. Envolve métodos de escrita com lógica de auditoria.
 */
export function Auditable<T extends {new (...args: any[]): any}>(constructor: T, context?: ClassDecoratorContext): T {
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

      // Captura estado anterior para UPDATE e DELETE
      let before: any = null;
      if ((action === "UPDATE" || action === "DELETE") && entityId && tx) {
        try {
          const modelName = (this.constructor as any).modelName || className.replace("Controller", "");
          // Tenta buscar o registro atual pela PK
          const prismaModel = (tx as any)[modelName.charAt(0).toLowerCase() + modelName.slice(1)];
          if (prismaModel?.findUnique) {
            before = await prismaModel.findUnique({where: {id: entityId}});
          }
        } catch {
          // ignora se não conseguir buscar o estado anterior
        }
      }

      // Intercepta res.json/res.end para capturar o resultado
      const originalJson = res.json.bind(res);
      let capturedResponse: any = null;

      res.json = function (body: any) {
        capturedResponse = body;
        return originalJson(body);
      };

      const result = await originalMethod.call(this, req, res, ...rest);

      // Grava auditoria após sucesso (não-bloqueante para a resposta)
      const after = action === "DELETE" ? null : capturedResponse?.data || this.data || null;
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

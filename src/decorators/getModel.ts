import { ClientError } from "../errors/commons";
import { logger } from "../functions/logger";
import { isDecoratorContext } from "./_proxy";

// Registry central
const registry = {
  models: new Map(), // tag → Model
  daos: new Map(), // tag → DAO
};

/** Registra o model pela `static tag`; tag repetida derruba o processo. */
function registerModel(target: any): void {
  if (typeof target.tag === "undefined") {
    throw new ClientError(
      `[@mateusseiboth/ts-decorators] Model ${target.name} não possui static tag`,
    );
  }

  // Verifica se a tag já está registrada
  if (registry.models.has(target.tag)) {
    const existingModel = registry.models.get(target.tag);
    logger.error(`\n[@mateusseiboth/ts-decorators]❌ ERRO: Tag duplicada detectada!`);
    logger.error(`[@mateusseiboth/ts-decorators]   Tag: "${target.tag}"`);
    logger.error(`[@mateusseiboth/ts-decorators]   Model existente: ${existingModel.name}`);
    logger.error(`[@mateusseiboth/ts-decorators]   Tentativa de registrar: ${target.name}`);
    logger.error(
      `\n[@mateusseiboth/ts-decorators]   Cada Model deve ter uma tag única no sistema.\n`,
    );
    process.exit(1);
  }

  registry.models.set(target.tag, target);
}

/**
 * No TC39 o decorator da classe roda ANTES dos campos estáticos: o `static tag = N` ainda não
 * existe. Sem a tag agora, o registro espera o inicializador da classe, que roda depois deles.
 */
export function ModelTagged(target: any, context?: ClassDecoratorContext) {
  const isTc39 = context !== undefined && isDecoratorContext(context);
  if (isTc39 && typeof target.tag === "undefined") {
    context.addInitializer(function (this: unknown) {
      registerModel(this ?? target);
    });
    return;
  }
  registerModel(target);
}

export interface DAOForOptions {
  /**
   * Liga a trava otimista no `updateById` deste DAO: o update só grava se a versão que o
   * cliente carregou ainda for a do banco. Default: `false`.
   */
  optimisticLock?: boolean;
  /** Coluna que guarda a versão (o instante da última gravação). Default: `"updated_at"`. */
  versionColumn?: string;
}

/** A trava otimista ligada para um DAO: a coluna da versão. */
export interface OptimisticLock {
  column: string;
}

// Classe do DAO → trava otimista. Classe sem a opção não entra.
const optimisticLocks = new WeakMap<object, OptimisticLock>();

const saveOptimisticLock = (target: object, options: DAOForOptions) => {
  if (!options.optimisticLock) return;
  optimisticLocks.set(target, { column: options.versionColumn ?? "updated_at" });
};

/** A trava do DAO (classe ou instância), procurando também nas classes base. */
export function getOptimisticLock(dao: unknown): OptimisticLock | undefined {
  const classe = typeof dao === "function" ? dao : (dao as object | undefined)?.constructor;
  if (!classe || classe === Object || classe === Function.prototype) return undefined;
  return optimisticLocks.get(classe) ?? getOptimisticLock(Object.getPrototypeOf(classe));
}

// Decorator para DAOs
export function DAOFor(modelTag: any, options: DAOForOptions = {}) {
  return function (target: any, _context?: ClassDecoratorContext) {
    const Model = registry.models.get(modelTag);
    if (!Model) {
      throw new ClientError(
        `[@mateusseiboth/ts-decorators] Model com tag ${modelTag} não encontrado`,
      );
    }
    target.model = Model; // vincula Model no DAO
    registry.daos.set(modelTag, target);
    saveOptimisticLock(target, options);
  };
}

// Funções utilitárias
export function getModel(tag: string | number) {
  return registry.models.get(tag);
}

export function getDAO(tag: string | number) {
  return registry.daos.get(tag);
}

export function getAllModels() {
  return Array.from(registry.models.values());
}

export function getAllDAOs() {
  return Array.from(registry.daos.values());
}

import { ClientError } from "../errors/commons";
import { logger } from "../functions/logger";
import { isDecoratorContext, warnLegacy } from "./_proxy";

// Registry central
const registry = {
  models: new Map(), // tag → Model
  daos: new Map(), // tag → DAO
};

export function ModelTagged(target: any, context?: ClassDecoratorContext) {
  if (!context || !isDecoratorContext(context)) {
    warnLegacy("ModelTagged");
  }
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

// Decorator para DAOs
export function DAOFor(modelTag: any) {
  return function (target: any, context?: ClassDecoratorContext) {
    if (!context || !isDecoratorContext(context)) {
      warnLegacy("DAOFor");
    }
    const Model = registry.models.get(modelTag);
    if (!Model) {
      throw new ClientError(
        `[@mateusseiboth/ts-decorators] Model com tag ${modelTag} não encontrado`,
      );
    }
    target.model = Model; // vincula Model no DAO
    registry.daos.set(modelTag, target);
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

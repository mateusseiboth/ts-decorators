import "reflect-metadata";
import {OPTIONS_FILTER} from "./src/constants/default";
import {clearLegacyWarnings, isDecoratorContext, warnLegacy} from "./src/decorators/_proxy";
import {Auditable, setAuditStorage, type AuditEntry} from "./src/decorators/auditable";
import {AutoConvert} from "./src/decorators/autoConvert";
import {CacheMethod, Cacheable, clearAllCache, getCacheStats} from "./src/decorators/cacheable";
import {container} from "./src/decorators/container";
import {folderRouter} from "./src/decorators/folder-router";
import {DAOFor, ModelTagged, getAllDAOs, getAllModels, getDAO, getModel} from "./src/decorators/getModel";
import {GlobalRouter} from "./src/decorators/global-router";
import {Field, InitFields, getFieldTypeByKey, getFieldTypes} from "./src/decorators/initFields";
import {Injectable} from "./src/decorators/Injectable";
import {logDecorator} from "./src/decorators/log";
import {NestedModel, getNestedModel, getNestedModelMeta} from "./src/decorators/nestedModel";
import {RateLimit, RateLimitMethod, clearRateLimitStore, rateLimitMiddleware} from "./src/decorators/rateLimit";
import {RegistryRouter} from "./src/decorators/registry-router";
import {RouteBuilder} from "./src/decorators/router-builder";
import {ROUTERS_KEY} from "./src/decorators/router-metadata";
import {Transactional, TransactionalClass, setTransactionalCompanyFn} from "./src/decorators/transactional";
import {Validate, WithValidation, type IWithValidation} from "./src/decorators/validate";
import {validateRouteFile} from "./src/decorators/validate-route-file";
import {collectFieldMeta, collectFieldTypes} from "./src/functions/collectFieldsTypes";
import {extractAndRemoveByKey} from "./src/functions/extractAndRemoveByKey";
import {jwtDecode} from "./src/functions/jwt";
import {makePrismaOptions, removeFromWhere} from "./src/functions/makePrismaOptions";
import {filterObjectByModel, getModelKeys} from "./src/functions/object";
import {addCompanyIdToTransaction, convertBigIntValues, executePrismaQuery, type IResponsePaginate} from "./src/functions/sql";
import {getOrderBy} from "./src/middlwares/getOrderBy";
import {getPaginate} from "./src/middlwares/getPaginate";
import {buildWhereFromQuery, createWhereCondition, createWhereConditionQuery, getWhere} from "./src/middlwares/getWhere";
import {idempotencyMiddleware as Idempotent} from "./src/middlwares/idempotent";
import {Audit} from "./src/handlers/Audit";
import {Transactional as TransactionalHandler} from "./src/handlers/Transactional";
import {compose} from "./src/handlers/compose";
import {withTransaction} from "./src/handlers/withTransaction";
import {getPrismaClient, setPrismaClient, type PrismaClientLike} from "./src/handlers/prisma";
import {getHandlerContext, requireHandlerContext, setHandlerContext, type HandlerContext} from "./src/handlers/context";
import {AuditLogger, type AuditEntry as HttpAuditEntry} from "./src/storage/AuditLogger";

export {
  Audit,
  AuditLogger,
  Auditable,
  AutoConvert,
  CacheMethod,
  Cacheable,
  DAOFor,
  Field,
  GlobalRouter,
  Idempotent,
  InitFields,
  Injectable,
  ModelTagged,
  NestedModel,
  OPTIONS_FILTER,
  ROUTERS_KEY,
  RateLimit,
  RateLimitMethod,
  RegistryRouter,
  RouteBuilder,
  Transactional,
  TransactionalClass,
  TransactionalHandler,
  Validate,
  WithValidation,
  addCompanyIdToTransaction,
  buildWhereFromQuery,
  clearAllCache,
  container,
  clearLegacyWarnings,
  clearRateLimitStore,
  collectFieldMeta,
  collectFieldTypes,
  convertBigIntValues,
  createWhereCondition,
  createWhereConditionQuery,
  executePrismaQuery,
  extractAndRemoveByKey,
  filterObjectByModel,
  folderRouter,
  getAllDAOs,
  getAllModels,
  getCacheStats,
  getDAO,
  getFieldTypeByKey,
  getFieldTypes,
  getModel,
  getModelKeys,
  getNestedModel,
  getNestedModelMeta,
  getOrderBy,
  getPaginate,
  getWhere,
  isDecoratorContext,
  jwtDecode,
  logDecorator,
  makePrismaOptions,
  rateLimitMiddleware,
  removeFromWhere,
  setAuditStorage,
  setTransactionalCompanyFn,
  validateRouteFile,
  compose,
  getPrismaClient,
  getHandlerContext,
  requireHandlerContext,
  setHandlerContext,
  setPrismaClient,
  warnLegacy,
  withTransaction,
  type AuditEntry,
  type HandlerContext,
  type HttpAuditEntry,
  type IResponsePaginate,
  type IWithValidation,
  type PrismaClientLike,
};

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
import {
  All,
  Delete,
  Get,
  Head,
  HTTP_ROUTES_KEY,
  Options,
  Patch,
  Post,
  Put,
  applyControllerRoutes,
  getControllerRoutes,
  type ApplyControllerRoutesConfig,
  type HttpMethod,
  type RouteDefinition,
  type RouteOptions,
  type RouteWrapper,
} from "./src/decorators/http-methods";
import {
  REST_CONFIG_KEY,
  REST_PRESET,
  Rest,
  getRestRoutes,
  type RestAction,
  type RestConfig,
  type RestOverride,
} from "./src/decorators/rest";
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
import {Singleton, Scoped, Transient, type DiScope} from "./src/decorators/lifecycle";
import {MaskSensitive, applyMask, type MaskOptions} from "./src/decorators/maskSensitive";
import {RequiresRole, type RequiresRoleOptions} from "./src/decorators/requiresRole";
import {Emit} from "./src/decorators/emit";
import {Listen, initListeners} from "./src/decorators/listen";
import {Mutex} from "./src/decorators/mutex";
import {Semaphore as SemaphoreDecorator, clearSemaphores} from "./src/decorators/semaphore";
import {Cron, cronMatches, startCronJobs, stopAllCronJobs} from "./src/decorators/cron";
import {Queue, type QueueOptions} from "./src/decorators/queue";
import {Processor, initProcessors, type ProcessorOptions} from "./src/decorators/processor";
import {eventBus, EventBus, type EventHandler} from "./src/events/eventBus";
import {Mutex as MutexLock} from "./src/concurrency/Mutex";
import {Semaphore as SemaphoreLock} from "./src/concurrency/Semaphore";
import {InMemoryQueueAdapter} from "./src/queue/InMemoryQueueAdapter";
import {SqliteQueueAdapter} from "./src/queue/SqliteQueueAdapter";
import {
  clearQueues,
  enqueue,
  getQueueAdapter,
  registerProcessor,
  registerQueue,
  startProcessors,
  stopProcessors,
} from "./src/queue/registry";
import type {QueueAdapter, QueueJob} from "./src/queue/adapter";
import {Audit} from "./src/handlers/Audit";
import {Transactional as TransactionalHandler} from "./src/handlers/Transactional";
import {compose} from "./src/handlers/compose";
import {withTransaction} from "./src/handlers/withTransaction";
import {getPrismaClient, setPrismaClient, type PrismaClientLike} from "./src/handlers/prisma";
import {getHandlerContext, requireHandlerContext, setHandlerContext, type HandlerContext} from "./src/handlers/context";
import {AuditLogger, type AuditEntry as HttpAuditEntry} from "./src/storage/AuditLogger";

export {
  // --- Novos decorators ---
  Singleton,
  Scoped,
  Transient,
  MaskSensitive,
  applyMask,
  RequiresRole,
  Emit,
  Listen,
  initListeners,
  Mutex,
  SemaphoreDecorator as Semaphore,
  clearSemaphores,
  Cron,
  cronMatches,
  startCronJobs,
  stopAllCronJobs,
  Queue,
  Processor,
  initProcessors,
  // --- Infra (eventos / concorrência / filas) ---
  eventBus,
  EventBus,
  MutexLock,
  SemaphoreLock,
  InMemoryQueueAdapter,
  SqliteQueueAdapter,
  enqueue,
  getQueueAdapter,
  registerProcessor,
  registerQueue,
  startProcessors,
  stopProcessors,
  clearQueues,
  type DiScope,
  type MaskOptions,
  type RequiresRoleOptions,
  type QueueOptions,
  type ProcessorOptions,
  type EventHandler,
  type QueueAdapter,
  type QueueJob,
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
  // --- Rotas estilo NestJS (@Get, @Post, ...) ---
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Options,
  Head,
  All,
  HTTP_ROUTES_KEY,
  applyControllerRoutes,
  getControllerRoutes,
  type ApplyControllerRoutesConfig,
  type HttpMethod,
  type RouteDefinition,
  type RouteOptions,
  type RouteWrapper,
  // --- CRUD declarativo (@Rest) ---
  Rest,
  REST_PRESET,
  REST_CONFIG_KEY,
  getRestRoutes,
  type RestAction,
  type RestConfig,
  type RestOverride,
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

import "reflect-metadata";
import { Mutex as MutexLock } from "./src/concurrency/Mutex";
import { Semaphore as SemaphoreLock } from "./src/concurrency/Semaphore";
import { OPTIONS_FILTER } from "./src/constants/default";
import { clearLegacyWarnings, isDecoratorContext, warnLegacy } from "./src/decorators/_proxy";
import {
  Auditable,
  setAuditStorage,
  type AuditEntry,
  type AuditableOptions,
} from "./src/decorators/auditable";
import { AutoConvert } from "./src/decorators/autoConvert";
import { CacheMethod, Cacheable, clearAllCache, getCacheStats } from "./src/decorators/cacheable";
import { container } from "./src/decorators/container";
import {
  Cron,
  cronMatches,
  hasCronJobs,
  startCronJobs,
  stopAllCronJobs,
  stopCronJobs,
} from "./src/decorators/cron";
import { Emit } from "./src/decorators/emit";
import { AllRouters, folderRouter } from "./src/decorators/folder-router";
import {
  DAOFor,
  ModelTagged,
  getAllDAOs,
  getAllModels,
  getDAO,
  getModel,
} from "./src/decorators/getModel";
import { GlobalRouter } from "./src/decorators/global-router";
import {
  All,
  Delete,
  Get,
  HTTP_ROUTES_KEY,
  Head,
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
import { Field, InitFields, getFieldTypeByKey, getFieldTypes } from "./src/decorators/initFields";
import { Injectable } from "./src/decorators/Injectable";
import { Scoped, Singleton, Transient, type DiScope } from "./src/decorators/lifecycle";
import { Listen, disposeListeners, hasListeners, initListeners } from "./src/decorators/listen";
import { logDecorator } from "./src/decorators/log";
import { MaskSensitive, applyMask, type MaskOptions } from "./src/decorators/maskSensitive";
import {
  clearMetadataCache,
  getFreezeMetadata,
  setFreezeMetadata,
} from "./src/decorators/metadata";
import { Mutex } from "./src/decorators/mutex";
import {
  NestedModel,
  getNestedModel,
  getNestedModelMeta,
  getNestedModels,
} from "./src/decorators/nestedModel";
import { Processor, initProcessors, type ProcessorOptions } from "./src/decorators/processor";
import { Queue, type QueueOptions } from "./src/decorators/queue";
import {
  RateLimit,
  RateLimitMethod,
  clearRateLimitStore,
  rateLimitMiddleware,
} from "./src/decorators/rateLimit";
import { RegistryRouter } from "./src/decorators/registry-router";
import { RequiresRole, type RequiresRoleOptions } from "./src/decorators/requiresRole";
import {
  REST_CONFIG_KEY,
  REST_PRESET,
  Rest,
  getRestRoutes,
  type RestAction,
  type RestConfig,
  type RestOverride,
} from "./src/decorators/rest";
import { RouteBuilder } from "./src/decorators/router-builder";
import { ROUTERS_KEY } from "./src/decorators/router-metadata";
import { Semaphore as SemaphoreDecorator, clearSemaphores } from "./src/decorators/semaphore";
import {
  Transactional,
  TransactionalClass,
  setTransactionalCompanyFn,
  getSavepointPolicy,
  setSavepointPolicy,
  type SavepointPolicy,
} from "./src/decorators/transactional";
import { Validate, WithValidation, type IWithValidation } from "./src/decorators/validate";
import { validateRouteFile } from "./src/decorators/validate-route-file";
import { EventBus, eventBus, type EventHandler } from "./src/events/eventBus";
import { collectFieldMeta, collectFieldTypes } from "./src/functions/collectFieldsTypes";
import { extractAndRemoveByKey } from "./src/functions/extractAndRemoveByKey";
import { jwtDecode } from "./src/functions/jwt";
import {
  getLogLevel,
  isLevelEnabled,
  logger,
  setLogLevel,
  type LogLevel,
} from "./src/functions/logger";
import { makePrismaOptions, removeFromWhere } from "./src/functions/makePrismaOptions";
import { filterObjectByModel, getModelKeys, stableStringify } from "./src/functions/object";
import {
  addCompanyIdToTransaction,
  convertBigIntValues,
  executePrismaQuery,
  getDeriveTotalDefault,
  invalidateCountCache,
  setDeriveTotalDefault,
  type IResponsePaginate,
} from "./src/functions/sql";
import { Audit } from "./src/handlers/Audit";
import {
  defaultCompanyIdInjector,
  getCompanyIdInjector,
  noopCompanyIdInjector,
  resetCompanyIdInjector,
  setCompanyIdInjector,
  type CompanyIdInjector,
} from "./src/handlers/companyId";
import { compose } from "./src/handlers/compose";
import {
  getHandlerContext,
  requireHandlerContext,
  setHandlerContext,
  type HandlerContext,
} from "./src/handlers/context";
import { getPrismaClient, setPrismaClient, type PrismaClientLike } from "./src/handlers/prisma";
import { Transactional as TransactionalHandler } from "./src/handlers/Transactional";
import { withTransaction } from "./src/handlers/withTransaction";
import { getOrderBy } from "./src/middlwares/getOrderBy";
import { getPaginate } from "./src/middlwares/getPaginate";
import {
  buildWhereFromQuery,
  createWhereCondition,
  createWhereConditionQuery,
  getWhere,
} from "./src/middlwares/getWhere";
import { idempotencyMiddleware as Idempotent } from "./src/middlwares/idempotent";
import type { QueueAdapter, QueueJob } from "./src/queue/adapter";
import { InMemoryQueueAdapter } from "./src/queue/InMemoryQueueAdapter";
import {
  clearQueues,
  enqueue,
  getInFlightCount,
  getQueueAdapter,
  isProcessingPaused,
  pauseProcessors,
  registerProcessor,
  registerQueue,
  resumeProcessors,
  startProcessors,
  stopProcessors,
} from "./src/queue/registry";
import { SqliteQueueAdapter } from "./src/queue/SqliteQueueAdapter";
import {
  AuditLogger,
  type AuditEntry as HttpAuditEntry,
  type AuditLoggerOptions,
} from "./src/storage/AuditLogger";

export {
  All,
  AllRouters,
  Audit,
  AuditLogger,
  Auditable,
  AutoConvert,
  CacheMethod,
  Cacheable,
  Cron,
  DAOFor,
  Delete,
  Emit,
  EventBus,
  Field,
  // --- Rotas estilo NestJS (@Get, @Post, ...) ---
  Get,
  GlobalRouter,
  HTTP_ROUTES_KEY,
  Head,
  Idempotent,
  InMemoryQueueAdapter,
  InitFields,
  Injectable,
  Listen,
  MaskSensitive,
  ModelTagged,
  Mutex,
  MutexLock,
  NestedModel,
  OPTIONS_FILTER,
  Options,
  Patch,
  Post,
  Processor,
  Put,
  Queue,
  REST_CONFIG_KEY,
  REST_PRESET,
  ROUTERS_KEY,
  RateLimit,
  RateLimitMethod,
  RegistryRouter,
  RequiresRole,
  // --- CRUD declarativo (@Rest) ---
  Rest,
  RouteBuilder,
  Scoped,
  SemaphoreDecorator as Semaphore,
  SemaphoreLock,
  // --- Novos decorators ---
  Singleton,
  SqliteQueueAdapter,
  Transactional,
  TransactionalClass,
  TransactionalHandler,
  Transient,
  Validate,
  WithValidation,
  addCompanyIdToTransaction,
  applyControllerRoutes,
  applyMask,
  buildWhereFromQuery,
  clearAllCache,
  clearLegacyWarnings,
  clearQueues,
  clearRateLimitStore,
  clearSemaphores,
  collectFieldMeta,
  collectFieldTypes,
  compose,
  container,
  convertBigIntValues,
  createWhereCondition,
  createWhereConditionQuery,
  cronMatches,
  clearMetadataCache,
  disposeListeners,
  defaultCompanyIdInjector,
  enqueue,
  // --- Infra (eventos / concorrência / filas) ---
  eventBus,
  executePrismaQuery,
  extractAndRemoveByKey,
  filterObjectByModel,
  folderRouter,
  getAllDAOs,
  getAllModels,
  getCacheStats,
  getCompanyIdInjector,
  getControllerRoutes,
  getDAO,
  getFieldTypeByKey,
  getFieldTypes,
  getDeriveTotalDefault,
  getFreezeMetadata,
  getLogLevel,
  getHandlerContext,
  getModel,
  getModelKeys,
  getNestedModel,
  getNestedModelMeta,
  getNestedModels,
  getSavepointPolicy,
  getOrderBy,
  getPaginate,
  getPrismaClient,
  getQueueAdapter,
  getRestRoutes,
  getWhere,
  hasCronJobs,
  hasListeners,
  initListeners,
  invalidateCountCache,
  isLevelEnabled,
  logger,
  initProcessors,
  isDecoratorContext,
  jwtDecode,
  logDecorator,
  makePrismaOptions,
  noopCompanyIdInjector,
  rateLimitMiddleware,
  registerProcessor,
  registerQueue,
  removeFromWhere,
  requireHandlerContext,
  resetCompanyIdInjector,
  setAuditStorage,
  setCompanyIdInjector,
  setDeriveTotalDefault,
  setFreezeMetadata,
  setHandlerContext,
  setLogLevel,
  setSavepointPolicy,
  stableStringify,
  setPrismaClient,
  setTransactionalCompanyFn,
  startCronJobs,
  stopCronJobs,
  startProcessors,
  stopAllCronJobs,
  stopProcessors,
  getInFlightCount,
  isProcessingPaused,
  pauseProcessors,
  resumeProcessors,
  validateRouteFile,
  warnLegacy,
  withTransaction,
  type ApplyControllerRoutesConfig,
  type AuditEntry,
  type AuditLoggerOptions,
  type AuditableOptions,
  type LogLevel,
  type SavepointPolicy,
  type CompanyIdInjector,
  type DiScope,
  type EventHandler,
  type HandlerContext,
  type HttpAuditEntry,
  type HttpMethod,
  type IResponsePaginate,
  type IWithValidation,
  type MaskOptions,
  type PrismaClientLike,
  type ProcessorOptions,
  type QueueAdapter,
  type QueueJob,
  type QueueOptions,
  type RequiresRoleOptions,
  type RestAction,
  type RestConfig,
  type RestOverride,
  type RouteDefinition,
  type RouteOptions,
  type RouteWrapper,
};

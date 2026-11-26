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
import {
  CacheMethod,
  CacheProvider,
  Cacheable,
  Cached,
  clearAllCache,
  getCacheStats,
  reportCacheKey,
} from "./src/decorators/cacheable";
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
import { AllRouters, folderRouter, type MountedRouter } from "./src/decorators/folder-router";
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
import {
  Field,
  InitFields,
  getFieldTypeByKey,
  getFieldTypes,
  type FieldType,
  type FieldTypeName,
  type NestedModelType,
  type PrimitiveFieldType,
} from "./src/decorators/initFields";
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
import {
  clearRegisteredRoutes,
  endpointsOf,
  formatRoutesTable,
  getRegisteredRoutes,
  type RegisteredEndpoint,
  type RegisteredRoute,
} from "./src/decorators/route-registry";
import { RouteBuilder } from "./src/decorators/router-builder";
import { ROUTERS_KEY } from "./src/decorators/router-metadata";
import { Semaphore as SemaphoreDecorator, clearSemaphores } from "./src/decorators/semaphore";
import {
  Transactional,
  TransactionalClass,
  getSavepointPolicy,
  setSavepointPolicy,
  setTransactionalCompanyFn,
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
import { parseDate } from "./src/functions/parseDate";
import {
  getTemporalConverter,
  isDateLikeFieldType,
  isTemporalConstructor,
  parseDuration,
  parseInstant,
  parsePlainDate,
  parsePlainDateTime,
  parsePlainMonthDay,
  parsePlainTime,
  parsePlainYearMonth,
  parseZonedDateTime,
  temporalTypeName,
  type TemporalConstructor,
  type TemporalConverter,
  type TemporalFieldType,
  type TemporalTypeAlias,
  type TemporalTypeName,
} from "./src/functions/parseTemporal";
import {
  addCompanyIdToTransaction,
  applyColumnProjection,
  convertBigIntValues,
  executePrismaQuery,
  getDeriveTotalDefault,
  invalidateCountCache,
  paginar,
  setDeriveTotalDefault,
  type IResponsePaginate,
  type PaginateOptions,
  type PaginateSources,
} from "./src/functions/sql";
import { Audit } from "./src/handlers/Audit";
import {
  defaultCompanyIdInjector,
  getCompanyIdInjector,
  noopCompanyIdInjector,
  resetCompanyIdInjector,
  setCompanyIdInjector,
  type CompanyId,
  type CompanyIdInjector,
} from "./src/handlers/companyId";
import { compose } from "./src/handlers/compose";
import {
  getHandlerContext,
  publishRequestValue,
  requireHandlerContext,
  setHandlerContext,
  type HandlerContext,
} from "./src/handlers/context";
import {
  getPrismaClient,
  runInTransaction,
  setPrismaClient,
  type Prisma7ClientLike,
  type Prisma8ClientLike,
  type PrismaClientLike,
  type TransactionRunOptions,
} from "./src/handlers/prisma";
import { Transactional as TransactionalHandler } from "./src/handlers/Transactional";
import { withTransaction } from "./src/handlers/withTransaction";
import {
  compressResponse,
  type CompressResponseOptions,
  type ResponseEncoding,
} from "./src/middlwares/compressResponse";
import {
  buildSelectFromFields,
  getColumns,
  type GetColumnsOptions,
} from "./src/middlwares/getColumns";
import { getOrderBy } from "./src/middlwares/getOrderBy";
import { getPaginate } from "./src/middlwares/getPaginate";
import {
  buildWhereFromQuery,
  createWhereCondition,
  createWhereConditionQuery,
  getWhere,
} from "./src/middlwares/getWhere";
import { idempotencyMiddleware as Idempotent } from "./src/middlwares/idempotent";
import {
  clearPrisma8,
  configurePrisma8,
  getEnumLabels,
  getPrisma8,
  isNumericAsNumber,
  isPrisma7Tx,
  isPrisma8Tx,
  ormCollection,
  rawParamStatementPlan,
  rawRowsPlan,
  rawStatementPlan,
  resetPrisma8,
  runStatement,
  type ConfigurePrisma8Options,
  type EnumLabels,
  type Prisma8Ast,
  type Prisma8Config,
  type Prisma8Tx,
} from "./src/prisma8/client";
import { applyOrderBy, orderByLambdas } from "./src/prisma8/orderBy";
import { applyProjection, isRelationField, type ProjectionOptions } from "./src/prisma8/projection";
import {
  applyQueryOptions,
  collectionMeta,
  countRows,
  executeOrmQuery,
  readRows,
  type OrmCollection,
  type PagedQueryOptions,
  type QueryOptions,
} from "./src/prisma8/query";
import {
  datesFromTemporal,
  decodeForCodec,
  decodeRowsForCollection,
  encodeForCodec,
  encodeRowForCollection,
  fieldCodecs,
  isTemporal,
  isTemporalCodec,
  temporalToDate,
  temporalToIso,
  type FieldCodec,
} from "./src/prisma8/temporal";
import { applyWhere, buildPredicate, escapeLike } from "./src/prisma8/where";
import type { QueueAdapter, QueueJob, QueueStatusCounts } from "./src/queue/adapter";
import { InMemoryQueueAdapter } from "./src/queue/InMemoryQueueAdapter";
import {
  clearQueues,
  enqueue,
  getInFlightCount,
  getQueueAdapter,
  getQueueJobs,
  getQueueStats,
  isProcessingPaused,
  listQueues,
  pauseProcessors,
  purgeQueue,
  registerProcessor,
  registerQueue,
  removeQueueJob,
  resumeProcessors,
  retryQueueJob,
  startProcessors,
  stopProcessors,
  type QueueStats,
} from "./src/queue/registry";
import { SqliteQueueAdapter } from "./src/queue/SqliteQueueAdapter";
import {
  configureReportEngine,
  getOutputFormat,
  getReportEngine,
  listOutputFormats,
  registerOutputFormat,
  resetReportEngine,
} from "./src/report/config";
import { JsonOutputStrategy } from "./src/report/formats/JsonOutputStrategy";
import { ReportFormatRegistry } from "./src/report/formats/OutputStrategy";
import { PdfOutputStrategy } from "./src/report/formats/PdfOutputStrategy";
import { loadReportViewModel } from "./src/report/formats/viewModel";
import { getReportStatusMessage, NullReportNotifier } from "./src/report/notifier";
import { buildOrderByFunction } from "./src/report/orderBy";
import { ReportEngine } from "./src/report/ReportEngine";
import { createReportRouter } from "./src/report/router";
import type { ReportRouterOptions } from "./src/report/router";
import { SqliteTemplateStore } from "./src/report/templates/SqliteTemplateStore";
import type {
  EnqueueReportRequest,
  ReportAssinatura,
  ReportDataSource,
  ReportDataSourceResolver,
  ReportDefinition,
  ReportEngineHooks,
  ReportEngineOptions,
  ReportHeader,
  ReportJobPayload,
  ReportMainModule,
  ReportNotifier,
  ReportOutputContext,
  ReportOutputStrategy,
  ReportProgress,
  ReportQueueStatus,
  ReportQueueView,
  ReportRenderModule,
  ReportResult,
  ReportTemplate,
  ReportTemplateStore,
  ReportUser,
} from "./src/report/types";
import { planReportBatches } from "./src/report/worker/reportBatch";
import type { ReportBatchRange, ReportBatchWeight } from "./src/report/worker/reportBatch";
import {
  compressReportImage,
  detectImageMime,
  readBodyWithLimit,
} from "./src/report/worker/reportImage";
import type {
  CompressReportImageOptions,
  CompressedReportImage,
} from "./src/report/worker/reportImage";
import type { ReportWorkerStatus } from "./src/report/worker/ReportWorkerManager";
import {
  AuditLogger,
  type AuditEntry as HttpAuditEntry,
  type AuditLoggerOptions,
} from "./src/storage/AuditLogger";

export {
  // --- ts-decorators: rotas declarativas, tenant injetável, AllRouters ---
  All,
  AllRouters,
  Delete,
  Get,
  HTTP_ROUTES_KEY,
  Head,
  Options,
  Patch,
  Post,
  Put,
  REST_CONFIG_KEY,
  REST_PRESET,
  Rest,
  applyControllerRoutes,
  defaultCompanyIdInjector,
  getCompanyIdInjector,
  getControllerRoutes,
  getRestRoutes,
  noopCompanyIdInjector,
  publishRequestValue,
  rawParamStatementPlan,
  resetCompanyIdInjector,
  setCompanyIdInjector,
  type ApplyControllerRoutesConfig,
  type CompanyId,
  type CompanyIdInjector,
  type HttpMethod,
  type MountedRouter,
  type RestAction,
  type RestConfig,
  type RestOverride,
  type RouteDefinition,
  type RouteOptions,
  type RouteWrapper,
  // --- base comum ---
  Audit,
  AuditLogger,
  Auditable,
  AutoConvert,
  CacheMethod,
  CacheProvider,
  Cacheable,
  Cached,
  Cron,
  DAOFor,
  Emit,
  EventBus,
  Field,
  GlobalRouter,
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
  Processor,
  Queue,
  ROUTERS_KEY,
  RateLimit,
  RateLimitMethod,
  RegistryRouter,
  RequiresRole,
  RouteBuilder,
  Scoped,
  SemaphoreDecorator as Semaphore,
  SemaphoreLock,
  Singleton,
  SqliteQueueAdapter,
  Transactional,
  TransactionalClass,
  TransactionalHandler,
  Transient,
  Validate,
  WithValidation,
  addCompanyIdToTransaction,
  applyColumnProjection,
  // --- Prisma 8 ---
  applyOrderBy,
  applyProjection,
  applyQueryOptions,
  applyWhere,
  buildPredicate,
  clearPrisma8,
  escapeLike,
  collectionMeta,
  configurePrisma8,
  countRows,
  datesFromTemporal,
  decodeForCodec,
  decodeRowsForCollection,
  encodeForCodec,
  encodeRowForCollection,
  executeOrmQuery,
  fieldCodecs,
  getEnumLabels,
  getPrisma8,
  isNumericAsNumber,
  isPrisma7Tx,
  isPrisma8Tx,
  isRelationField,
  isTemporal,
  isTemporalCodec,
  orderByLambdas,
  ormCollection,
  paginar,
  rawRowsPlan,
  rawStatementPlan,
  readRows,
  resetPrisma8,
  runInTransaction,
  runStatement,
  temporalToDate,
  temporalToIso,
  applyMask,
  buildSelectFromFields,
  buildWhereFromQuery,
  clearAllCache,
  clearLegacyWarnings,
  clearMetadataCache,
  clearQueues,
  clearRateLimitStore,
  clearSemaphores,
  collectFieldMeta,
  collectFieldTypes,
  compose,
  compressResponse,
  container,
  convertBigIntValues,
  createWhereCondition,
  createWhereConditionQuery,
  cronMatches,
  disposeListeners,
  enqueue,
  // --- Infra (eventos / concorrência / filas) ---
  eventBus,
  executePrismaQuery,
  extractAndRemoveByKey,
  filterObjectByModel,
  folderRouter,
  clearRegisteredRoutes,
  endpointsOf,
  formatRoutesTable,
  getRegisteredRoutes,
  getAllDAOs,
  getAllModels,
  getCacheStats,
  getColumns,
  getDAO,
  getDeriveTotalDefault,
  getFieldTypeByKey,
  getFieldTypes,
  getFreezeMetadata,
  getHandlerContext,
  getLogLevel,
  getInFlightCount,
  getModel,
  getModelKeys,
  getNestedModel,
  getNestedModelMeta,
  getNestedModels,
  getOrderBy,
  getSavepointPolicy,
  getPaginate,
  getPrismaClient,
  getQueueAdapter,
  getQueueJobs,
  getQueueStats,
  getTemporalConverter,
  purgeQueue,
  removeQueueJob,
  retryQueueJob,
  getWhere,
  hasCronJobs,
  hasListeners,
  initListeners,
  invalidateCountCache,
  initProcessors,
  isDateLikeFieldType,
  isDecoratorContext,
  isLevelEnabled,
  listQueues,
  isProcessingPaused,
  isTemporalConstructor,
  jwtDecode,
  logDecorator,
  logger,
  makePrismaOptions,
  parseDate,
  parseDuration,
  parseInstant,
  parsePlainDate,
  parsePlainDateTime,
  parsePlainMonthDay,
  parsePlainTime,
  parsePlainYearMonth,
  parseZonedDateTime,
  pauseProcessors,
  rateLimitMiddleware,
  registerProcessor,
  registerQueue,
  removeFromWhere,
  reportCacheKey,
  requireHandlerContext,
  resumeProcessors,
  setAuditStorage,
  setDeriveTotalDefault,
  setFreezeMetadata,
  setHandlerContext,
  setLogLevel,
  setPrismaClient,
  setSavepointPolicy,
  setTransactionalCompanyFn,
  stableStringify,
  startCronJobs,
  stopCronJobs,
  startProcessors,
  temporalTypeName,
  stopAllCronJobs,
  stopProcessors,
  validateRouteFile,
  warnLegacy,
  withTransaction,
  // --- Report engine ---
  JsonOutputStrategy,
  NullReportNotifier,
  PdfOutputStrategy,
  ReportEngine,
  ReportFormatRegistry,
  SqliteTemplateStore,
  buildOrderByFunction,
  compressReportImage,
  configureReportEngine,
  createReportRouter,
  detectImageMime,
  readBodyWithLimit,
  getOutputFormat,
  getReportEngine,
  getReportStatusMessage,
  listOutputFormats,
  loadReportViewModel,
  planReportBatches,
  registerOutputFormat,
  resetReportEngine,
  type AuditEntry,
  type AuditLoggerOptions,
  type AuditableOptions,
  type CompressResponseOptions,
  type DiScope,
  type ResponseEncoding,
  type EventHandler,
  type GetColumnsOptions,
  type HandlerContext,
  type HttpAuditEntry,
  type IResponsePaginate,
  type IWithValidation,
  type LogLevel,
  type MaskOptions,
  type PrismaClientLike,
  type Prisma7ClientLike,
  type Prisma8ClientLike,
  type Prisma8Ast,
  type Prisma8Config,
  type Prisma8Tx,
  type ConfigurePrisma8Options,
  type EnumLabels,
  type FieldCodec,
  type ProjectionOptions,
  type OrmCollection,
  type PagedQueryOptions,
  type QueryOptions,
  type TransactionRunOptions,
  type PaginateOptions,
  type PaginateSources,
  type ProcessorOptions,
  type QueueAdapter,
  type QueueJob,
  type QueueOptions,
  type QueueStats,
  type QueueStatusCounts,
  type RegisteredEndpoint,
  type RegisteredRoute,
  type ReportWorkerStatus,
  type RequiresRoleOptions,
  type SavepointPolicy,
  // --- Report engine (types) ---
  type CompressReportImageOptions,
  type CompressedReportImage,
  type EnqueueReportRequest,
  type ReportAssinatura,
  type ReportBatchRange,
  type ReportBatchWeight,
  type ReportDataSource,
  type ReportDataSourceResolver,
  type ReportDefinition,
  type ReportEngineHooks,
  type ReportEngineOptions,
  type ReportHeader,
  type ReportJobPayload,
  type ReportMainModule,
  type ReportNotifier,
  type ReportOutputContext,
  type ReportOutputStrategy,
  type ReportProgress,
  type ReportQueueStatus,
  type ReportQueueView,
  type ReportRenderModule,
  type ReportResult,
  type ReportRouterOptions,
  type ReportTemplate,
  type ReportTemplateStore,
  type ReportUser,
  type FieldType,
  type FieldTypeName,
  type NestedModelType,
  type PrimitiveFieldType,
  type TemporalConstructor,
  type TemporalConverter,
  type TemporalFieldType,
  type TemporalTypeAlias,
  type TemporalTypeName,
};

// --- Camada de dados (paginação, filtro pelo contrato, Prisma 8) ---
export type { DAOForOptions } from "./src/decorators/getModel";
export { getFieldOptions, type FieldOptions } from "./src/decorators/initFields";
export type { HandlerContextOptions } from "./src/handlers/context";
export { OptimisticLockError } from "./src/errors/optimisticLock";
export {
  EncryptionError,
  configureEncryption,
  countByEncryptionKey,
  decryptValue,
  encryptValue,
  isEncryptedValue,
  keyFingerprint,
  listEncryptionKeys,
  reencryptColumn,
  resetEncryption,
  type ConfigureEncryptionOptions,
  type EncryptionErrorCode,
  type EncryptionKeyInfo,
  type ReencryptColumnOptions,
  type ReencryptReport,
} from "./src/fields/encryption";
export {
  normalizeValue,
  type FieldNormalize,
  type FieldNormalizeFn,
  type FieldNormalizeName,
} from "./src/fields/normalize";
export { checkEncryptedModels } from "./src/fields/rowFields";
export { readIfMatch, updateById, type UpdateByIdOptions } from "./src/functions/updateById";
export { afterCommit } from "./src/handlers/afterCommit";
export {
  BUCKETS_BYTES,
  BUCKETS_DB,
  BUCKETS_HTTP,
  BUCKETS_PADRAO,
  BUCKETS_QUEUE,
} from "./src/observability/buckets";
export {
  getTenantLabel,
  incrementMetric,
  recordMetric,
  registerGauge,
  type GaugeObservation,
  type IncrementMetricOptions,
  type MetricAttributes,
  type MetricInstrumentOptions,
  type RecordMetricOptions,
  type RegisterGaugeOptions,
} from "./src/observability/metrics";
export { assertWhereFitsContract, InvalidFilterError } from "./src/prisma8/contractFilter";
export { prepareRead, readShared, shareReads, type PreparedQuery } from "./src/prisma8/reads";
export { EMPTY_SQL, joinSql, sql, SqlFragment, toTemplate } from "./src/prisma8/sqlFragment";

/**
 * `@mateusseiboth/ts-decorators/observability`: o SDK do OpenTelemetry, o middleware HTTP e o
 * console no formato do logger. Importa `@opentelemetry/*` direto; o ponto de entrada principal
 * não (ele usa `getOtelApi`).
 */
export { isBodyCaptureMarked, markBodyCapture } from "./bodyCapture";
export { observeHttp, type ObserveHttpOptions } from "./httpMiddleware";
export { type ExporterKind, type ObservabilityOptions } from "./options";
export { startObservability, type ObservabilityHandle } from "./sdk";

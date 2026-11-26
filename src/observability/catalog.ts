/**
 * Os instrumentos que o próprio pacote grava: nome, unidade e descrição num lugar só. Os nomes são
 * contrato com os dashboards (o exporter do collector os converte: `s` vira `_seconds`, contador
 * ganha `_total`). Mudar um nome aqui quebra painel em produção.
 */

import type { MetricInstrumentOptions } from "./metrics";

const define = <T extends Record<string, Required<MetricInstrumentOptions>>>(catalogo: T): T =>
  catalogo;

export const METRICA = define({
  METHOD_DURATION: {
    name: "app.method.duration",
    unit: "s",
    description: "Duração das chamadas de método medidas pelo @Timed.",
  },
  METHOD_CALLS: {
    name: "app.method.calls",
    unit: "{call}",
    description: "Chamadas de método contadas pelo @Counted.",
  },
  DB_OPERATION: {
    name: "db.client.operation.duration",
    unit: "s",
    description: "Duração de cada statement enviado ao banco pelo Prisma 8.",
  },
  DB_TRANSACTION: {
    name: "db.client.transaction.duration",
    unit: "s",
    description: "Duração das transações do Prisma 8, da abertura ao commit ou rollback.",
  },
  ADVISORY_LOCK_WAIT: {
    name: "app.advisory_lock.wait.duration",
    unit: "s",
    description: "Espera pela trava do @AdvisoryLock.",
  },
  QUEUE_ENQUEUED: {
    name: "queue.job.enqueued",
    unit: "{job}",
    description: "Jobs enfileirados.",
  },
  QUEUE_DURATION: {
    name: "queue.job.duration",
    unit: "s",
    description: "Duração da execução do job pelo consumidor.",
  },
  QUEUE_WAIT: {
    name: "queue.job.wait.duration",
    unit: "s",
    description: "Espera do job na fila, do enfileiramento ao início da execução.",
  },
  QUEUE_FINISHED: {
    name: "queue.job.finished",
    unit: "{job}",
    description: "Jobs terminados, com sucesso ou erro.",
  },
  QUEUE_JOBS: {
    name: "queue.jobs",
    unit: "{job}",
    description: "Jobs no armazenamento da fila, por status.",
  },
  QUEUE_IN_FLIGHT: {
    name: "queue.jobs.in_flight",
    unit: "{job}",
    description: "Jobs em execução neste processo.",
  },
  IDEMPOTENCY_REPLAY: {
    name: "app.idempotency.replay",
    unit: "{request}",
    description: "Pedidos repetidos respondidos com o resultado guardado, sem rodar de novo.",
  },
  OPTIMISTIC_LOCK_CONFLICT: {
    name: "app.optimistic_lock.conflict",
    unit: "{conflict}",
    description: "Gravações recusadas pela trava otimista (o registro mudou antes).",
  },
  PERMISSION_DENIED: {
    name: "app.permission.denied",
    unit: "{request}",
    description: "Pedidos negados pelas permissões.",
  },
  AUDIT_WRITE_FAILURE: {
    name: "app.audit.write_failure",
    unit: "{failure}",
    description: "Falhas ao gravar o log de auditoria.",
  },
  REPORT_RENDER: {
    name: "app.report.render.duration",
    unit: "s",
    description: "Duração da geração de cada relatório.",
  },
  DRAIN_ACTIVE: {
    name: "app.drain.active",
    unit: "1",
    description: "1 enquanto o processo drena para o deploy, 0 fora disso.",
  },
  HEALTH_CHECK: {
    name: "app.health.check",
    unit: "1",
    description: "Último resultado de cada sonda de saúde: 1 no ar, 0 fora.",
  },
  ERRORS: {
    name: "app.errors",
    unit: "{error}",
    description: "Erros que viraram resposta HTTP.",
  },
  PROCESS_MEMORY: {
    name: "process.memory.usage",
    unit: "By",
    description: "Memória do processo, por tipo.",
  },
  PROCESS_CPU: {
    name: "process.cpu.time",
    unit: "s",
    description: "Tempo de CPU do processo, por modo.",
  },
  PROCESS_EVENT_LOOP_DELAY: {
    name: "process.event_loop.delay",
    unit: "s",
    description: "Maior atraso do event loop em cada janela de amostra.",
  },
  PROCESS_UPTIME: {
    name: "process.uptime",
    unit: "s",
    description: "Tempo desde a subida do processo.",
  },
});

/** Desfecho de uma operação medida. */
export const OUTCOME = { OK: "ok", ERRO: "erro" } as const;
export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

export const toOutcome = (ok: boolean): Outcome => (ok ? OUTCOME.OK : OUTCOME.ERRO);

import type { ReportNotifier, ReportQueueView } from "./types";

/** Notifier no-op — apps sem WebSocket (ou testes). */
export class NullReportNotifier implements ReportNotifier {
  notifyStatus(): void {}
  notifyProgress(): void {}
}

const STATUS_MESSAGES: Record<string, (item: ReportQueueView) => string> = {
  enqueued: (item) => `Relatório na fila. Posição: ${item.position} de ${item.queueSize}`,
  processing: () => "Processando relatório...",
  completed: () => "Relatório gerado com sucesso.",
  error: (item) => item.error || "Erro ao gerar relatório.",
};

export function getReportStatusMessage(item: ReportQueueView): string {
  return (STATUS_MESSAGES[item.status] ?? (() => "Status desconhecido"))(item);
}

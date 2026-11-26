import { compressReportImage, readBodyWithLimit, type CompressedReportImage } from "./reportImage";

export interface LoadReportHeaderImageOptions {
  /** Limite do download. Padrão: `REPORT_HEADER_IMAGE_MAX_BYTES` ou 10 MB. */
  maxBytes?: number;
  /** Chamado quando o brasão não pôde ser carregado. O relatório segue sem ele. */
  onFailure?: (error: Error) => void;
}

export interface ReportHeaderImage extends CompressedReportImage {
  originalBytes: number;
}

const readTimeoutMs = (): number =>
  Math.max(5_000, Number(process.env.REPORT_HEADER_IMAGE_TIMEOUT_MS) || 30_000);

const readMaxBytes = (): number =>
  Math.max(1024, Number(process.env.REPORT_HEADER_IMAGE_MAX_BYTES) || 10 * 1024 * 1024);

async function fetchHeaderImage(url: string, maxBytes: number): Promise<ReportHeaderImage> {
  const timeoutMs = readTimeoutMs();
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`Falha ao carregar o brasão do relatório (HTTP ${response.status}).`);
  }
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (declaredBytes > maxBytes) {
    throw new Error(`Brasão excede o limite de ${maxBytes} bytes (${declaredBytes} bytes).`);
  }
  // Interrompe o download assim que ultrapassar o limite — response.arrayBuffer()
  // só permitiria validar depois de já ter alocado todo o arquivo em memória.
  const original = await readBodyWithLimit(response.body, maxBytes);

  const compacted = await compressReportImage(original, {
    mimeType: response.headers.get("content-type") || undefined,
    maxWidth: Number(process.env.REPORT_HEADER_IMAGE_MAX_WIDTH) || 256,
    maxHeight: Number(process.env.REPORT_HEADER_IMAGE_MAX_HEIGHT) || 256,
    maxSourcePixels: Number(process.env.REPORT_HEADER_IMAGE_MAX_PIXELS) || 20_000_000,
    quality: Number(process.env.REPORT_HEADER_IMAGE_QUALITY) || 0.9,
    timeoutMs,
  });
  return { ...compacted, originalBytes: original.length };
}

/**
 * Baixa e comprime o brasão do cabeçalho. O brasão é enfeite: qualquer falha
 * (HTTP de erro, limite, rede, imagem inválida) devolve `null` e o relatório
 * sai sem ele, em vez de derrubar o job inteiro.
 */
export async function loadReportHeaderImage(
  url: string,
  options: LoadReportHeaderImageOptions = {},
): Promise<ReportHeaderImage | null> {
  const maxBytes = options.maxBytes ?? readMaxBytes();
  return fetchHeaderImage(url, maxBytes).catch((error: unknown) => {
    options.onFailure?.(error instanceof Error ? error : new Error(String(error)));
    return null;
  });
}

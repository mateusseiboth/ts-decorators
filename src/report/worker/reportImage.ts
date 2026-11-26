/**
 * Compressão do brasão do cabeçalho, pelo `Bun.Image` (Bun >= 1.4): redimensiona para dentro da
 * caixa (sem aumentar) e grava WebP. Sem o `Bun.Image` (Bun antigo), o brasão segue no formato
 * original e o log avisa que precisa do Bun 1.4. SVG é recusado: o `Bun.Image` não rasteriza, e
 * SVG sem rasterizar levaria XML e referências externas ao navegador do relatório.
 */

export interface CompressReportImageOptions {
  mimeType?: string;
  maxWidth?: number;
  maxHeight?: number;
  maxSourcePixels?: number;
  quality?: number;
  timeoutMs?: number;
}

export interface CompressedReportImage {
  buffer: Buffer;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
}

/** O que o relatório usa do `Bun.Image`. */
interface BunImagePipeline {
  metadata(): Promise<{ width: number; height: number; format?: string }>;
  resize(width: number, height: number, options: { fit: "inside" }): BunImagePipeline;
  webp(options: { quality: number }): BunImagePipeline;
  toBuffer(): Promise<Buffer>;
}

type BunImageConstructor = new (dados: Buffer) => BunImagePipeline;

/** `Bun.Image` existe a partir do Bun 1.4. */
const findBunImage = (): BunImageConstructor | undefined =>
  (globalThis as { Bun?: { Image?: BunImageConstructor } }).Bun?.Image;

const withoutCompressao = (input: Buffer, mimeType: string): CompressedReportImage => {
  console.warn(
    "[REPORT] Sem compressão de imagem: este runtime não tem `Bun.Image` (requer Bun >= 1.4.0). " +
      "O brasão seguirá no formato original, sem resize. Atualize o Bun para 1.4.0+.",
  );
  return { buffer: input, mimeType, originalWidth: 0, originalHeight: 0, width: 0, height: 0 };
};

const requireDimensoes = (width: number, height: number, maxPixels: number): void => {
  if (!width || !height) throw new Error("O brasão não possui dimensões válidas.");
  if (width * height > maxPixels) throw new Error(`Brasão excede o limite de ${maxPixels} pixels.`);
};

/**
 * Compressão pelo runtime. `Bun.Image.resize` AUMENTA a imagem: brasão menor que a caixa é
 * recomprimido no tamanho original, nunca esticado. Recomprimir sem reduzir pode sair MAIOR que o
 * original; nesse caso o original vence.
 */
async function compressWithBunImage(
  Image: BunImageConstructor,
  input: Buffer,
  mimeType: string,
  limites: { maxWidth: number; maxHeight: number; quality: number; maxPixels: number },
): Promise<CompressedReportImage> {
  const { width: originalWidth, height: originalHeight } = await new Image(input).metadata();
  requireDimensoes(originalWidth, originalHeight, limites.maxPixels);

  const cabeNaCaixa = originalWidth <= limites.maxWidth && originalHeight <= limites.maxHeight;
  const pipeline = cabeNaCaixa
    ? new Image(input)
    : new Image(input).resize(limites.maxWidth, limites.maxHeight, { fit: "inside" });
  const buffer = await pipeline.webp({ quality: Math.round(limites.quality * 100) }).toBuffer();

  if (cabeNaCaixa && buffer.length >= input.length) {
    return {
      buffer: input,
      mimeType,
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
    };
  }

  const { width, height } = await new Image(buffer).metadata();
  return { buffer, mimeType: "image/webp", originalWidth, originalHeight, width, height };
}

export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer> {
  if (!body) throw new Error("A resposta do brasão não possui conteúdo.");

  const limit = Math.max(1, Math.floor(maxBytes));
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      receivedBytes += value.byteLength;
      if (receivedBytes > limit) {
        await reader.cancel("Limite do brasão excedido.").catch(() => undefined);
        throw new Error(
          `Brasão excede o limite de ${limit} bytes (${receivedBytes} bytes recebidos).`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, receivedBytes);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function detectImageMime(buffer: Buffer, declaredMime?: string): string {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString("ascii") === "PNG"
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString("ascii") === "GIF8") {
    return "image/gif";
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") {
    return "image/bmp";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  const textPrefix = buffer.subarray(0, Math.min(buffer.length, 512)).toString("utf8").trimStart();
  if (
    textPrefix.startsWith("<svg") ||
    (textPrefix.startsWith("<?xml") && textPrefix.includes("<svg"))
  ) {
    return "image/svg+xml";
  }

  const normalizedDeclared = (String(declaredMime || "").split(";", 1)[0] ?? "")
    .trim()
    .toLowerCase();
  return normalizedDeclared.startsWith("image/") ? normalizedDeclared : "image/png";
}

/**
 * Compacta o brasão diretamente no Buffer, antes de gerar qualquer Base64. A saída em WebP remove
 * metadados e limita os pixels que serão incorporados ao PDF.
 */
export async function compressReportImage(
  input: Buffer,
  options: CompressReportImageOptions = {},
): Promise<CompressedReportImage> {
  const mimeType = detectImageMime(input, options.mimeType);
  if (mimeType === "image/svg+xml") {
    throw new Error("Brasão em SVG não é suportado. Use PNG, JPEG, WebP ou BMP.");
  }

  const Image = findBunImage();
  if (!Image) return withoutCompressao(input, mimeType);

  const maxWidth = Math.max(32, Math.round(Number(options.maxWidth) || 256));
  const maxHeight = Math.max(32, Math.round(Number(options.maxHeight) || 256));
  return compressWithBunImage(Image, input, mimeType, {
    maxWidth,
    maxHeight,
    quality: clamp(Number(options.quality) || 0.9, 0.4, 0.95),
    // O limite nunca fica abaixo da própria caixa.
    maxPixels: Math.max(
      maxWidth * maxHeight,
      Math.round(Number(options.maxSourcePixels) || 20_000_000),
    ),
  });
}

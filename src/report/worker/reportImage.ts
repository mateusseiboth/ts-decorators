/**
 * Compressão do brasão do cabeçalho.
 *
 * Prioridade: `Bun.Image` (nativo, a partir do Bun 1.4) → `sharp` (peer dependency
 * OPCIONAL) → imagem original sem resize. Só o sharp rasteriza SVG, então SVG continua
 * indo por ele. Sem nenhum dos dois o relatório continua saindo, apenas maior, e o log
 * avisa o que instalar/atualizar.
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

/** `Bun.Image` existe a partir do Bun 1.4. Antes disso, só o sharp comprime. */
function temBunImage(): boolean {
  return typeof (globalThis as { Bun?: { Image?: unknown } }).Bun?.Image === "function";
}

/**
 * Compressão pelo runtime, sem dependência nativa. Duas diferenças em relação ao sharp
 * são tratadas aqui de propósito:
 *  - `Bun.Image.resize` AUMENTA a imagem; o sharp tinha `withoutEnlargement`. Brasão menor
 *    que a caixa é recomprimido no tamanho original, nunca esticado.
 *  - `Bun.Image` NÃO decodifica SVG, por isso quem chama já desviou o SVG para o sharp.
 */
async function comprimirComBunImage(
  input: Buffer,
  mimeType: string,
  limites: { maxWidth: number; maxHeight: number; quality: number },
): Promise<CompressedReportImage> {
  const Image = (globalThis as unknown as { Bun: { Image: new (dados: Buffer) => any } }).Bun.Image;
  const { width: originalWidth, height: originalHeight } = await new Image(input).metadata();
  if (!originalWidth || !originalHeight) throw new Error("O brasão não possui dimensões válidas.");

  const cabeNaCaixa = originalWidth <= limites.maxWidth && originalHeight <= limites.maxHeight;
  const pipeline = cabeNaCaixa
    ? new Image(input)
    : new Image(input).resize(limites.maxWidth, limites.maxHeight, { fit: "inside" });
  const buffer: Buffer = await pipeline
    .webp({ quality: Math.round(limites.quality * 100) })
    .toBuffer();

  // Recomprimir sem reduzir pode sair MAIOR que o original; nesse caso o original vence.
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

let sharpModule: any | null | undefined;

async function loadSharp(): Promise<any | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    const mod = await import("sharp");
    const sharp = mod.default ?? mod;
    // O worker permanece vivo entre jobs. O cache nativo do libvips não traz ganho
    // perceptível para um único brasão por relatório e manteria memória fora do heap.
    sharp.cache(false);
    sharp.concurrency(1);
    sharpModule = sharp;
  } catch {
    sharpModule = null;
    console.warn(
      "[REPORT] Sem compressão de imagem: este runtime não tem `Bun.Image` (requer Bun >= 1.4.0) " +
        "e o `sharp` não está instalado. O brasão seguirá no formato original, sem resize. " +
        "Atualize o Bun para 1.4.0+ ou rode `npm i sharp`.",
    );
  }
  return sharpModule;
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

function mimeFromSharpFormat(format?: string): string | undefined {
  const formats: Record<string, string> = {
    avif: "image/avif",
    gif: "image/gif",
    heif: "image/heif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    tiff: "image/tiff",
    webp: "image/webp",
  };
  return format ? formats[format.toLowerCase()] : undefined;
}

interface DecodedBitmap {
  pixels: Buffer;
  width: number;
  height: number;
}

/**
 * O webservice legado entrega alguns brasões como BMP 24 bits, apesar da URL e
 * do Content-Type indicarem JPEG. A build pré-compilada do Sharp não inclui um
 * loader de BMP, então decodificamos apenas o formato sem compressão aceito
 * pelo sistema e entregamos RGB puro ao libvips.
 */
function decodeUncompressedBitmap(input: Buffer, maxPixels: number): DecodedBitmap {
  if (input.length < 54 || input.subarray(0, 2).toString("ascii") !== "BM") {
    throw new Error("O brasão BMP possui um cabeçalho inválido.");
  }

  const pixelOffset = input.readUInt32LE(10);
  const dibSize = input.readUInt32LE(14);
  const width = input.readInt32LE(18);
  const signedHeight = input.readInt32LE(22);
  const planes = input.readUInt16LE(26);
  const bitsPerPixel = input.readUInt16LE(28);
  const compression = input.readUInt32LE(30);
  const height = Math.abs(signedHeight);
  const pixelCount = width * height;

  if (dibSize < 40 || width <= 0 || height <= 0 || planes !== 1) {
    throw new Error("O brasão BMP possui dimensões ou cabeçalho inválidos.");
  }
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new Error(`Brasão BMP de ${bitsPerPixel} bits não é suportado.`);
  }
  if (compression !== 0) {
    throw new Error("Brasão BMP compactado não é suportado.");
  }
  if (!Number.isSafeInteger(pixelCount) || pixelCount > maxPixels) {
    throw new Error(`Brasão excede o limite de ${maxPixels} pixels.`);
  }

  const sourceBytesPerPixel = bitsPerPixel / 8;
  const rowStride = Math.ceil((width * bitsPerPixel) / 32) * 4;
  const expectedEnd = pixelOffset + rowStride * height;
  if (
    pixelOffset < 14 + dibSize ||
    !Number.isSafeInteger(expectedEnd) ||
    expectedEnd > input.length
  ) {
    throw new Error("Os pixels do brasão BMP estão incompletos.");
  }

  const pixels = Buffer.allocUnsafe(pixelCount * 3);
  for (let outputY = 0; outputY < height; outputY++) {
    const sourceY = signedHeight > 0 ? height - outputY - 1 : outputY;
    const sourceRow = pixelOffset + sourceY * rowStride;
    const outputRow = outputY * width * 3;

    for (let x = 0; x < width; x++) {
      const source = sourceRow + x * sourceBytesPerPixel;
      const output = outputRow + x * 3;
      // `?? 0` só existe para o noUncheckedIndexedAccess: os índices são calculados
      // dentro do buffer, nunca saem do intervalo.
      pixels[output] = input[source + 2] ?? 0;
      pixels[output + 1] = input[source + 1] ?? 0;
      pixels[output + 2] = input[source] ?? 0;
    }
  }

  return { pixels, width, height };
}

/**
 * Compacta o brasão diretamente no Buffer, antes de gerar qualquer Base64.
 * A saída em WebP remove metadados e limita os pixels que serão incorporados ao PDF.
 * Sem `sharp` instalado, devolve o buffer original com o mime detectado.
 */
export async function compressReportImage(
  input: Buffer,
  options: CompressReportImageOptions = {},
): Promise<CompressedReportImage> {
  const mimeType = detectImageMime(input, options.mimeType);
  const maxWidth = Math.max(32, Math.round(Number(options.maxWidth) || 256));
  const maxHeight = Math.max(32, Math.round(Number(options.maxHeight) || 256));
  const qualidade = clamp(Number(options.quality) || 0.9, 0.4, 0.95);

  // SVG precisa ser RASTERIZADO e só o sharp faz isso — `Bun.Image` recusa o formato.
  if (mimeType !== "image/svg+xml" && temBunImage()) {
    return comprimirComBunImage(input, mimeType, { maxWidth, maxHeight, quality: qualidade });
  }

  const sharp = await loadSharp();
  if (!sharp) {
    return {
      buffer: input,
      mimeType,
      originalWidth: 0,
      originalHeight: 0,
      width: 0,
      height: 0,
    };
  }

  const maxSourcePixels = Math.max(
    maxWidth * maxHeight,
    Math.round(Number(options.maxSourcePixels) || 20_000_000),
  );
  const quality = clamp(Number(options.quality) || 0.9, 0.4, 0.95);
  const timeoutSeconds = Math.ceil(Math.max(5_000, Number(options.timeoutMs) || 30_000) / 1_000);
  const bitmap = mimeType === "image/bmp" ? decodeUncompressedBitmap(input, maxSourcePixels) : null;
  const image = bitmap
    ? sharp(bitmap.pixels, {
        raw: { width: bitmap.width, height: bitmap.height, channels: 3 },
        limitInputPixels: maxSourcePixels,
      })
    : sharp(input, { failOn: "error", limitInputPixels: maxSourcePixels });
  const metadata = await image.metadata();
  const originalWidth = bitmap?.width || metadata.width;
  const originalHeight = bitmap?.height || metadata.height;
  const originalMimeType = bitmap ? "image/bmp" : mimeFromSharpFormat(metadata.format) || mimeType;
  if (!originalWidth || !originalHeight) {
    throw new Error("O brasão não possui dimensões válidas.");
  }

  const { data: compressed, info } = await image
    .autoOrient()
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality: Math.round(quality * 100),
      alphaQuality: 90,
      effort: 4,
      preset: "icon",
      smartSubsample: true,
    })
    .timeout({ seconds: timeoutSeconds })
    .toBuffer({ resolveWithObject: true });

  const resized = info.width !== originalWidth || info.height !== originalHeight;
  // SVG sempre é rasterizado: além de uniformizar o formato, elimina XML e
  // referências externas antes de a imagem chegar ao navegador do relatório.
  if (!bitmap && metadata.format !== "svg" && !resized && compressed.length >= input.length) {
    return {
      buffer: input,
      mimeType: originalMimeType,
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
    };
  }

  return {
    buffer: compressed,
    mimeType: "image/webp",
    originalWidth,
    originalHeight,
    width: info.width,
    height: info.height,
  };
}

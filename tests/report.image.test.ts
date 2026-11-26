import { afterEach, describe, expect, test } from "bun:test";

import { compressReportImage } from "../src/report/worker/reportImage";

/**
 * Compressao do brasao, so pelo `Bun.Image` (Bun >= 1.4). Sem ele (Bun antigo), o brasao
 * passa como veio e o log avisa que precisa do Bun 1.4.
 */
const PNG_320x200 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAACXBIWXMAAAPoAAAD6AG1e1JrAAABvUlEQVR42u3TQQkAAAgEwXub2IjGMoQvYWASLGyqB3gqEoCBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgOrAAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYDAwYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDAZWAQwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDFwvv31bfj2g+IQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_64x48 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAQ0lEQVRo3u3PQQkAAAgEsEty/aMYywp+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBqwWJJzC1rWH8dQAAAABJRU5ErkJggg==",
  "base64",
);

/** BMP 24 bits sem compressão, como o que alguns servidores entregam com a extensão errada. */
const buildBmp = (width: number, height: number): Buffer => {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const tamanho = 54 + stride * height;
  const bmp = Buffer.alloc(tamanho, 0x80);
  bmp.write("BM", 0, "ascii");
  bmp.writeUInt32LE(tamanho, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(0, 30);
  bmp.writeUInt32LE(stride * height, 34);
  return bmp;
};

const bunGlobal = globalThis as unknown as { Bun: { Image?: unknown } };
const IMAGE_ORIGINAL = bunGlobal.Bun.Image;

afterEach(() => {
  bunGlobal.Bun.Image = IMAGE_ORIGINAL;
});

describe("compressReportImage", () => {
  test("reduz para dentro da caixa e devolve webp", async () => {
    const saida = await compressReportImage(PNG_320x200, { maxWidth: 128, maxHeight: 128 });

    expect(saida.mimeType).toBe("image/webp");
    expect(saida.originalWidth).toBe(320);
    expect(saida.originalHeight).toBe(200);
    expect(saida.width).toBeLessThanOrEqual(128);
    expect(saida.height).toBeLessThanOrEqual(128);
    // proporcao preservada (fit: inside): 320x200 -> 128x80
    expect(saida.width / saida.height).toBeCloseTo(320 / 200, 1);
    expect(saida.buffer.length).toBeLessThan(PNG_320x200.length);
  });

  /**
   * `Bun.Image.resize` AUMENTA a imagem. Brasao pequeno esticado para 256 sairia borrado e
   * maior que o original.
   */
  test("NAO aumenta imagem menor que a caixa", async () => {
    const saida = await compressReportImage(PNG_64x48, { maxWidth: 256, maxHeight: 256 });

    expect(saida.originalWidth).toBe(64);
    expect(saida.originalHeight).toBe(48);
    expect(saida.width).toBe(64);
    expect(saida.height).toBe(48);
  });

  test("sem Bun.Image: devolve o original e avisa que precisa do Bun 1.4", async () => {
    // `Bun.Image` e writable mas nao configurable: da para sobrescrever, nao para deletar.
    bunGlobal.Bun.Image = undefined;
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void avisos.push(args.map(String).join(" "));

    try {
      const saida = await compressReportImage(PNG_320x200, { maxWidth: 128, maxHeight: 128 });
      expect(saida.buffer).toBe(PNG_320x200);
      expect(saida.mimeType).toBe("image/png");
      expect(avisos.join(" ")).toMatch(/1\.4/);
    } finally {
      console.warn = original;
    }
  });

  test("BMP vai pelo Bun.Image e sai webp", async () => {
    const saida = await compressReportImage(buildBmp(300, 200), { maxWidth: 128, maxHeight: 128 });
    expect(saida.mimeType).toBe("image/webp");
    expect(saida.originalWidth).toBe(300);
    expect(saida.width).toBeLessThanOrEqual(128);
  });

  test("SVG é recusado: sem rasterizador, o relatório sai sem o brasão", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(compressReportImage(svg)).rejects.toThrow("SVG");
  });

  test("imagem acima do limite de pixels é recusada antes de redimensionar", async () => {
    await expect(
      compressReportImage(PNG_320x200, { maxWidth: 32, maxHeight: 32, maxSourcePixels: 1_000 }),
    ).rejects.toThrow("pixels");
  });
});

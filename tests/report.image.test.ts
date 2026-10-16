import { afterEach, describe, expect, mock, test } from "bun:test";

import { compressReportImage } from "../src/report/worker/reportImage";

/**
 * Compressao do brasao. O caminho exercitado aqui e o do `Bun.Image` (Bun >= 1.4).
 * O `sharp` e peer OPCIONAL (esta em devDependencies so para o typecheck do worker);
 * o cenario "sem `Bun.Image` e sem `sharp`" — o que antes deixava o brasao passar
 * sem compressao nenhuma — e simulado com `mock.module`, e nao pela ausencia do
 * pacote: teste que depende do que esta instalado quebra quando alguem instala.
 */
const PNG_320x200 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAAACXBIWXMAAAPoAAAD6AG1e1JrAAABvUlEQVR42u3TQQkAAAgEwXub2IjGMoQvYWASLGyqB3gqEoCBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgOrAAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYDAwYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDAZWAQwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDFwvv31bfj2g+IQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_64x48 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAQ0lEQVRo3u3PQQkAAAgEsEty/aMYywp+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBqwWJJzC1rWH8dQAAAABJRU5ErkJggg==",
  "base64",
);

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
   * `Bun.Image.resize` AUMENTA a imagem, ao contrario do `withoutEnlargement` do sharp.
   * Brasao pequeno esticado para 256 sairia borrado e maior que o original.
   */
  test("NAO aumenta imagem menor que a caixa", async () => {
    const saida = await compressReportImage(PNG_64x48, { maxWidth: 256, maxHeight: 256 });

    expect(saida.originalWidth).toBe(64);
    expect(saida.originalHeight).toBe(48);
    expect(saida.width).toBe(64);
    expect(saida.height).toBe(48);
  });

  test("sem Bun.Image e sem sharp: devolve o original e avisa que precisa do Bun 1.4", async () => {
    // `Bun.Image` e writable mas nao configurable: da para sobrescrever, nao para deletar.
    bunGlobal.Bun.Image = undefined;
    // Simula o `sharp` ausente: o import dinamico do loadSharp passa a falhar.
    mock.module("sharp", () => {
      throw new Error("sharp nao instalado (simulado)");
    });
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
});

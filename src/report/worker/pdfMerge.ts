import { spawn } from "child_process";

/**
 * Mescla os arquivos em processo externo (pdfunite/poppler-utils), sem carregar
 * todas as páginas no heap do Bun. Binário substituível via REPORT_PDF_MERGE_BIN.
 */
export async function mergePdfParts(partPaths: string[], outputPath: string): Promise<void> {
  const bin = process.env.REPORT_PDF_MERGE_BIN || "pdfunite";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, [...partPaths, outputPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `Utilitário "${bin}" não encontrado. Instale poppler-utils (ou aponte REPORT_PDF_MERGE_BIN) para mesclar relatórios grandes.`,
          ),
        );
        return;
      }
      reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Falha ao mesclar PDFs (${bin} code=${code}): ${stderr.trim()}`));
    });
  });
}

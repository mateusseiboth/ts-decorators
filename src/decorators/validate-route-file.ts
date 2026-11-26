import fs from "fs/promises";

const forbiddenPatterns = ["child_process", "eval(", "new Function", "while(true)", "process.exit"];

function hasRegistryExport(content: string) {
  return content.includes("export function registry") || content.includes("export const registry");
}

/** Recusa o arquivo do roteamento por pasta (rota ou `_middlewares`) com conteúdo suspeito. */
export function assertWithoutForbiddenPatterns(content: string, filePath: string): void {
  for (const pattern of forbiddenPatterns) {
    if (content.includes(pattern)) {
      throw new Error(["Arquivo suspeito detectado.", filePath, `Pattern: ${pattern}`].join("\n"));
    }
  }
}

export async function validateRouteFile(filePath: string) {
  const content = await fs.readFile(filePath, "utf-8");

  if (!hasRegistryExport(content)) {
    return false;
  }

  assertWithoutForbiddenPatterns(content, filePath);
  return true;
}

import { startStudioServer } from "../studio/server";

function parsePort(args: string[]): number {
  const index = args.indexOf("--port");
  if (index === -1) return 4123;
  const port = Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Porta inválida: "${args[index + 1]}"`);
  }
  return port;
}

/** STUDIO_ALLOWED_ORIGINS="http://app1:3000,http://app2" trava o proxy nesses sistemas. */
const readAllowedOrigins = () =>
  (process.env.STUDIO_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const readPort = (args: string[]) =>
  args.includes("--port") ? parsePort(args) : Number(process.env.STUDIO_PORT ?? 4123);

const isPortInUse = (error: unknown) => (error as { code?: string } | null)?.code === "EADDRINUSE";

export async function runStudio(args: string[]): Promise<void> {
  const port = readPort(args);
  const allowedOrigins = readAllowedOrigins();
  const studio = await startStudioServer({ port, allowedOrigins }).catch((error: unknown) => {
    if (!isPortInUse(error)) throw error;
    console.error(`A porta ${port} já está em uso. Feche o outro Studio ou use --port <outra>.`);
    process.exit(1);
  });
  console.log(`\n🎨 ts-decorators Studio rodando em ${studio.url}\n`);
  console.log("   1. Comece por um modelo pronto (Novo) ou abra um modelo do sistema.");
  console.log(
    "   2. Carregue dados: cole um JSON ou conecte ao sistema (rota .../data/:reportId).",
  );
  console.log("   3. Arraste os campos, use os assistentes e acompanhe a prévia e os problemas.");
  console.log("   4. Gere o PDF real para conferir e publique o modelo no sistema.");
  console.log("   Ctrl+K abre a paleta com todos os comandos.\n");
  if (allowedOrigins.length) console.log(`   Sistemas permitidos: ${allowedOrigins.join(", ")}\n`);
}

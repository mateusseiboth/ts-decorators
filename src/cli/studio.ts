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

export async function runStudio(args: string[]): Promise<void> {
  const port = parsePort(args);
  await startStudioServer(port);
  console.log(`\n🎨 ts-decorators Studio rodando em http://localhost:${port}\n`);
  console.log("   1. Cole um JSON de dados ou conecte ao sistema (POST .../data/:reportId).");
  console.log("   2. Arraste os campos do painel esquerdo para o editor, ou use os assistentes");
  console.log("      de Tabela, Condicional e Cálculo — o preview atualiza em tempo real.");
  console.log("   3. Exporte o template para o sistema (POST .../templates/:reportId).\n");
}

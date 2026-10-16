import type { ReportOutputStrategy } from "../types";

/**
 * Registry de formatos de saída (Strategy/Factory) — formato novo = registrar
 * uma strategy; nenhum if/else por formato no pipeline.
 */
export class ReportFormatRegistry {
  private readonly strategies = new Map<string, ReportOutputStrategy>();

  register(strategy: ReportOutputStrategy): void {
    this.strategies.set(strategy.format, strategy);
  }

  get(format: string): ReportOutputStrategy {
    const strategy = this.strategies.get(format);
    if (!strategy) {
      throw new Error(
        `Formato de relatório desconhecido: "${format}". Registrados: ${this.list().join(", ")}`,
      );
    }
    return strategy;
  }

  has(format: string): boolean {
    return this.strategies.has(format);
  }

  list(): string[] {
    return [...this.strategies.keys()];
  }
}

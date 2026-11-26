/**
 * Métricas do processo: memória, CPU, uptime e atraso do event loop.
 *
 * O atraso do event loop sai do `monitorEventLoopDelay` do `node:perf_hooks` (o Bun 1.4
 * implementa): a cada janela, o MAIOR atraso visto vira um ponto do histograma, e a janela
 * recomeça. Sem ele, a amostra é o atraso do próprio timer da janela (quanto ele disparou depois
 * da hora), que enxerga o mesmo bloqueio com resolução menor.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

import { METRICA } from "./catalog";
import { recordMetric, registerGauge, registerObservable } from "./metrics";

/** Janela padrão da amostra do atraso do event loop, em ms. */
export const JANELA_DO_EVENT_LOOP_MS = 1000;
/** Resolução do `monitorEventLoopDelay`, em ms. */
const RESOLUCAO_MS = 10;

const recordAtraso = (segundos: number): void =>
  recordMetric({ ...METRICA.PROCESS_EVENT_LOOP_DELAY, value: Math.max(0, segundos) });

/** Uma amostra por janela; devolve a função que para. */
type Amostrador = (janelaMs: number) => () => void;

const startTimer = (janelaMs: number, tick: () => void): (() => void) => {
  const timer = setInterval(tick, janelaMs);
  // A métrica não pode segurar o processo de pé.
  timer.unref?.();
  return () => clearInterval(timer);
};

const amostrarPeloMonitor: Amostrador = (janelaMs) => {
  const histograma = monitorEventLoopDelay({ resolution: RESOLUCAO_MS });
  histograma.enable();
  const parar = startTimer(janelaMs, () => {
    // O histograma é em nanossegundos; janela sem medida não vira ponto.
    if (histograma.count > 0) recordAtraso(histograma.max / 1e9);
    histograma.reset();
  });
  return () => {
    parar();
    histograma.disable();
  };
};

const amostrarPeloTimer: Amostrador = (janelaMs) => {
  let anterior = performance.now();
  return startTimer(janelaMs, () => {
    const agora = performance.now();
    recordAtraso((agora - anterior - janelaMs) / 1000);
    anterior = agora;
  });
};

const hasMonitor = (): boolean => {
  try {
    monitorEventLoopDelay({ resolution: RESOLUCAO_MS }).disable();
    return true;
  } catch {
    return false;
  }
};

const startAmostraDoEventLoop = (janelaMs: number): (() => void) =>
  (hasMonitor() ? amostrarPeloMonitor : amostrarPeloTimer)(janelaMs);

const TIPOS_DE_MEMORIA: ReadonlyArray<[tipo: string, campo: keyof NodeJS.MemoryUsage]> = [
  ["rss", "rss"],
  ["heap_used", "heapUsed"],
  ["heap_total", "heapTotal"],
  ["external", "external"],
];

const observeMemoria = () => {
  const uso = process.memoryUsage();
  return TIPOS_DE_MEMORIA.map(([type, campo]) => ({ value: uso[campo], attributes: { type } }));
};

const observeCpu = () => {
  const { user, system } = process.cpuUsage();
  return [
    { value: user / 1e6, attributes: { "cpu.mode": "user" } },
    { value: system / 1e6, attributes: { "cpu.mode": "system" } },
  ];
};

/** Liga as métricas do processo; devolve a função que desliga. */
export function registerRuntimeMetrics(janelaMs = JANELA_DO_EVENT_LOOP_MS): () => void {
  const desligar = [
    registerGauge({ ...METRICA.PROCESS_MEMORY, observe: observeMemoria }),
    registerObservable("observableCounter", { ...METRICA.PROCESS_CPU, observe: observeCpu }),
    registerGauge({ ...METRICA.PROCESS_UPTIME, observe: () => process.uptime() }),
    startAmostraDoEventLoop(janelaMs),
  ];
  return () => {
    for (const desliga of desligar) desliga();
  };
}

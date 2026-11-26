/**
 * Worker persistente de PDF — embarcado no pacote.
 *
 * Recebe do ReportWorkerManager um payload PLANO com caminhos ABSOLUTOS
 * (renderModulePath/partialsDir/outputDir) resolvidos pela engine na main
 * thread — o worker não conhece aliases nem o layout do app.
 *
 * Pipeline por job: import dinâmico do render da view → helpers/partials
 * Handlebars → brasão (fetch limitado + Bun.Image) → HTML em disco →
 * Chromium QUENTE (page.goto file://) → PDF em lotes por peso (opt-in da view)
 * → merge pdfunite → progresso via postMessage.
 *
 * playwright e handlebars são peer dependencies: só este arquivo os importa, e
 * ele roda em thread própria — o load do pacote nunca os toca.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { pathToFileURL } from "url";
import { parentPort } from "worker_threads";

import Handlebars from "handlebars";
import { chromium, firefox, type Browser } from "playwright";

import { buildOrderByFunction } from "../orderBy";
import { registerDefaultReportHelpers } from "../templateHelpers";
import { prepareAttachmentFile } from "./attachmentFiles";
import { loadReportHeaderImage } from "./headerImage";
import { stampContinuousPageNumbers } from "./pageNumbers";
import {
  buildAttachmentCuts,
  buildMergeOrder,
  hasPdfAttachments,
  planPdfAttachments,
  type ReportGetGroupKey,
  type ReportGetPdfAttachments,
  type ReportPdfAttachmentPlan,
} from "./pdfAttachments";
import { mergePdfParts } from "./pdfMerge";
import { buildPdfOptions } from "./pdfOptions";
import { planReportBatches, type ReportBatchWeight } from "./reportBatch";

/**
 * Canal com a thread principal.
 *
 * O ReportWorkerManager cria este worker com `worker_threads.Worker` (API do Node).
 * Escutar por `self.onmessage` (API de Web Worker) NAO recebe nada no Bun: sao canais
 * diferentes, e a mensagem sai da thread principal e simplesmente nunca chega — o job
 * fica pendurado para sempre. Ver tests/report.worker-manager.test.ts.
 */
const requireCanal = () => {
  if (!parentPort) {
    throw new Error("[REPORT:WORKER] precisa ser iniciado como worker_threads.Worker.");
  }
  return parentPort;
};
const canal = requireCanal();

const USE_FIREFOX = process.env.ENABLE_FIREFOX_REPORT === "1";

// ── Chrome quente (persistente) ──────────────────────────────────────────────
// Um único navegador é aberto no boot do worker e REUTILIZADO por todos os jobs
// (uma page nova por relatório, fechada ao final). launch()/close() por job fazia
// dois relatórios concorrentes derrubarem um ao outro ("Browser is in closing state").
let browserPromise: Promise<Browser> | null = null;

async function launchBrowser(): Promise<Browser> {
  const browser = await (USE_FIREFOX ? firefox.launch() : chromium.launch());
  // Se o navegador cair (crash/OOM), zera para relançar sob demanda no próximo job.
  browser.on("disconnected", () => {
    browserPromise = null;
    console.warn("[REPORT:WORKER] ⚠️  Chrome desconectou — será relançado no próximo job.");
  });
  console.log(`[REPORT:WORKER] 🌐 Chrome quente pronto (${USE_FIREFOX ? "Firefox" : "Chromium"}).`);
  return browser;
}

/** Devolve o navegador quente, relançando se tiver caído. Seguro para chamadas concorrentes. */
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) browserPromise = launchBrowser();
  const browser = await browserPromise;
  if (browser.isConnected()) return browser;
  browserPromise = null;
  return getBrowser();
}

// Aquece o Chrome já no boot do worker — "sempre pronto" antes do 1º relatório.
void getBrowser().catch((err) => console.error("[REPORT:WORKER] Falha ao aquecer o Chrome:", err));

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}min ${Math.round((ms % 60_000) / 1000)}s`;
}

function collectGarbage(): void {
  try {
    const bunGc = (globalThis as any).Bun?.gc;
    if (typeof bunGc === "function") {
      bunGc(true);
      return;
    }
    (globalThis as any).gc?.();
  } catch {
    // Coleta explícita é apenas uma ajuda entre lotes; nunca deve derrubar o job.
  }
}

/**
 * Remove TODOS os artefatos temporários de um job por prefixo do jobId, preservando
 * apenas o PDF final `${jobId}.pdf`. Independe do rastreamento em memória e é seguro
 * entre jobs concorrentes (cada job tem UUID próprio).
 */
function removeJobArtifacts(reportDir: string, jobId: string): void {
  if (!jobId || !existsSync(reportDir)) return;
  const prefix = `${jobId}.`;
  const finalPdf = `${jobId}.pdf`;
  let removed = 0;
  let releasedBytes = 0;

  for (const entry of readdirSync(reportDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(prefix) || entry.name === finalPdf) continue;
    const filePath = `${reportDir}/${entry.name}`;
    try {
      releasedBytes += statSync(filePath).size;
      unlinkSync(filePath);
      removed++;
    } catch {
      // Outro fluxo (renderHtmlFileToPdf/merge) pode ter removido o temporário antes.
    }
  }

  if (removed > 0) {
    console.log(
      `[REPORT:WORKER][${jobId}] 🧹 ${removed} temporário(s) do job removido(s), ${fmtBytes(releasedBytes)} liberados.`,
    );
  }
}

const staleCleanedDirs = new Set<string>();

function cleanupStaleReportFiles(reportDir: string): void {
  if (staleCleanedDirs.has(reportDir) || !existsSync(reportDir)) return;
  staleCleanedDirs.add(reportDir);
  // No boot não há job em voo: qualquer temporário é órfão de execução anterior
  // morta antes do `finally` (ex.: OOM). Purga cedo em vez de segurar por 24h.
  const maxAgeMs = Math.max(5 * 60_000, Number(process.env.REPORT_TEMP_MAX_AGE_MS) || 60 * 60_000);
  const cutoff = Date.now() - maxAgeMs;
  const temporaryName =
    /(?:\.part\d+\.(?:html|pdf)|\.page\d+\.json|\.merging\.pdf|\.header-image(?:\.[a-z0-9]+)?|^[^.]+\.html)$/i;
  let removed = 0;
  let releasedBytes = 0;

  for (const entry of readdirSync(reportDir, { withFileTypes: true })) {
    if (!entry.isFile() || !temporaryName.test(entry.name)) continue;
    const filePath = `${reportDir}/${entry.name}`;
    try {
      const file = statSync(filePath);
      if (file.mtimeMs >= cutoff) continue;
      unlinkSync(filePath);
      removed++;
      releasedBytes += file.size;
    } catch {
      // Outro processo pode remover o temporário entre readdir/stat/unlink.
    }
  }

  if (removed > 0) {
    console.log(
      `[REPORT:WORKER] 🧹 ${removed} temporário(s) antigo(s) removido(s), ${fmtBytes(releasedBytes)} liberados.`,
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} excedeu o limite de ${fmtMs(timeoutMs)}.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

console.log("[REPORT:WORKER] 🟢 Worker persistente iniciado — aguardando jobs...");

canal.on("message", (data: unknown) => {
  // Parse fora da função assíncrona: o ArrayBuffer serializado não fica preso
  // pelo evento durante todos os lotes do relatório.
  let options: any;
  try {
    options = JSON.parse(Buffer.from(data as Uint8Array).toString("utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[REPORT:WORKER] Não foi possível interpretar o job: ${message}`);
    // Sem jobId: o payload nao parseou, entao nao da para saber a qual job pertence.
    // O manager trata erro sem jobId como falha de protocolo e rejeita os pendentes,
    // em vez de deixa-los pendurados.
    canal.postMessage({ error: `Payload inválido do relatório: ${message}` });
    return;
  }
  void processReport(options);
});

/** Valida os campos obrigatórios do payload. Devolve a mensagem de erro ou null. */
function validateOptions(options: any): string | null {
  const validations: Array<[boolean, string]> = [
    [!options, "Erro ao ler informações da consulta"],
    [!options?.renderModulePath, "Módulo de render do relatório não fornecido"],
    [!options?.outputDir, "Diretório de saída não fornecido"],
    [
      // Válido se vier `data` (array ou envelope) OU `pageFiles` (streaming — o main já fatiou
      // as linhas em disco e não envia `data`). Sem nenhum dos dois → erro.
      !(Array.isArray(options?.pageFiles) && options.pageFiles.length > 0) &&
        (!options?.data || (!Array.isArray(options.data) && !Array.isArray(options.data?.data))),
      "Nenhum dado fornecido para o relatório",
    ],
    [!options?.title, "Título do relatório não fornecido"],
    [!options?.jobId, "ID do trabalho não fornecido"],
  ];
  const failed = validations.find(([invalid]) => invalid);
  return failed ? failed[1] : null;
}

async function processReport(options: any): Promise<void> {
  const jobId = options?.jobId;
  const startedAt = Date.now();
  const temporaryPaths = new Set<string>();

  // ── Logging instrumentado ────────────────────────────────────────────────
  // Cada etapa registra tempo desde a etapa anterior, tempo total e memória.
  // Um heartbeat imprime sinais de vida durante as operações longas do navegador.
  let lastStepAt = startedAt;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const mem = (): string => {
    const m = process.memoryUsage();
    return `rss ${fmtBytes(m.rss)} · heap ${fmtBytes(m.heapUsed)}`;
  };
  const step = (emoji: string, msg: string): void => {
    const now = Date.now();
    console.log(
      `[REPORT:WORKER][${jobId ?? "?"}] ${emoji} ${msg} · +${fmtMs(now - lastStepAt)} (total ${fmtMs(now - startedAt)}) · ${mem()}`,
    );
    lastStepAt = now;
  };
  const startHeartbeat = (): void => {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      console.log(
        `[REPORT:WORKER][${jobId ?? "?"}] ⏳ ainda trabalhando… total ${fmtMs(Date.now() - startedAt)} · ${mem()}`,
      );
    }, 5000);
  };
  function stopHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }

  console.log(
    `[REPORT:WORKER] 📥 Job recebido: ${jobId ?? "(sem id)"} — "${options?.title ?? "?"}"`,
  );
  const validationError = validateOptions(options);
  if (validationError) {
    console.error(`[REPORT:WORKER] ${validationError}`);
    canal.postMessage({ jobId, error: validationError });
    return;
  }

  try {
    const {
      data,
      title,
      header,
      assinaturas,
      renderModulePath,
      partialsDir,
      outputDir,
      templateSource,
      viewSetupModule,
      filters = {},
      pageFormat,
      preferCSSPageSize,
    } = options;
    const reportDir = outputDir;
    if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
    cleanupStaleReportFiles(reportDir);

    step("🚀", `Iniciando processamento — "${title}"`);

    step("🧭", `Carregando módulo de render: ${renderModulePath}…`);
    const renderEngineModule = await import(renderModulePath);
    step("🧭", "Módulo de render carregado.");

    const { buildReportHTML } = renderEngineModule;
    if (typeof buildReportHTML !== "function") {
      throw new Error(`A view "${renderModulePath}" não exporta buildReportHTML.`);
    }

    registerDefaultReportHelpers(Handlebars);
    // Helpers custom do app (ex.: formatos específicos do sistema).
    if (viewSetupModule) {
      const setup = await import(viewSetupModule);
      await setup.registerReportHelpers?.(Handlebars);
    }

    const readPartial = (name: string): string => {
      const filePath = `${partialsDir}/${name}`;
      return existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
    };
    const headerTemplate = Handlebars.compile(readPartial("header.hbs"));
    const footerTemplate = Handlebars.compile(readPartial("footer.hbs"));
    Handlebars.registerPartial("assinaturas", readPartial("assinaturas.hbs"));

    const headerData = header ?? {};
    const headerImage = headerData.brasaoURL
      ? await loadReportHeaderImage(headerData.brasaoURL, {
          onFailure: (error) => step("⚠️", `Relatório segue sem brasão: ${error.message}`),
        })
      : null;
    headerData.brasaoBase64 = "";
    if (headerImage) {
      step(
        "🖼️",
        `Brasão preparado: ${fmtBytes(headerImage.originalBytes)} → ${fmtBytes(headerImage.buffer.length)} (${headerImage.mimeType}).`,
      );

      // O carnê tem uma capa por registro. Repetir um brasão grande como data URI
      // multiplica o HTML — renders que optam por esta estratégia gravam a imagem
      // uma vez e repetem somente a URL curta.
      if (renderEngineModule.EXTERNALIZE_HEADER_IMAGE === true) {
        const imagePath = `${reportDir}/${jobId}.header-image`;
        writeFileSync(imagePath, headerImage.buffer);
        temporaryPaths.add(imagePath);
        headerData.brasaoBase64 = pathToFileURL(imagePath).href;
      }
      if (renderEngineModule.EXTERNALIZE_HEADER_IMAGE !== true) {
        headerData.brasaoBase64 = `data:${headerImage.mimeType};base64,${headerImage.buffer.toString("base64")}`;
      }
    }
    const viewModel = {
      title,
      header: headerData,
      filters,
      ano: new Date().getFullYear(),
    };

    const orderByFunction = buildOrderByFunction(filters);

    // Opções de page.pdf() (cabeçalho/rodapé só quando o relatório não os desabilita).
    const readPdfOptions = (disableHeaderFooter: boolean, hidePageNumber = false) =>
      buildPdfOptions({
        disableHeaderFooter,
        headerHTML: disableHeaderFooter ? "" : headerTemplate(viewModel.header),
        // hidePageNumber: nas partes bateadas o número do rodapé é reescrito depois (contínuo,
        // via pageNumbers.ts). O footer omite o número do Chromium para não sobrar texto-fantasma
        // por baixo (o Ctrl+F acharia "Página X de Y" por-parte). O template usa {{#unless hidePageNumber}}.
        footerHTML: disableHeaderFooter ? "" : footerTemplate({ ...viewModel, hidePageNumber }),
        pageFormat,
        preferCSSPageSize,
      });

    const pageTimeoutMs = Math.max(
      30_000,
      Number(process.env.REPORT_PAGE_TIMEOUT_MS) || 5 * 60_000,
    );

    // O HTML já chega gravado em disco para que a string possa ser liberada ANTES dos
    // awaits do Chromium. Um contexto isolado por parte impede cache/DOM de vazar entre lotes.
    const renderHtmlFileToPdf = async (
      browser: Browser,
      htmlFilePath: string,
      pdfFilePath: string,
      disableHeaderFooter: boolean,
      hidePageNumber = false,
    ): Promise<number> => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(pathToFileURL(htmlFilePath).href, {
          waitUntil: "load",
          timeout: pageTimeoutMs,
        });
        const pdfBuffer = await withTimeout(
          page.pdf({ ...readPdfOptions(disableHeaderFooter, hidePageNumber), path: pdfFilePath }),
          pageTimeoutMs,
          "Renderização do PDF",
        );
        return pdfBuffer.length;
      } finally {
        await context.close().catch(() => undefined);
        try {
          unlinkSync(htmlFilePath);
          temporaryPaths.delete(htmlFilePath);
        } catch {
          // arquivo já removido / inexistente — ignora
        }
      }
    };

    // Progresso para o app (notifier/painel): fase + parte X/Y + percentual.
    const emitProgress = (
      phase: "generating" | "merging",
      current: number,
      total: number,
      message: string,
    ): void => {
      const percent = total > 0 ? Math.round((current / total) * 100) : 0;
      canal.postMessage({
        jobId,
        progress: {
          phase,
          current,
          total,
          percent,
          message,
          meta: { parte: current, paginasGeradas: current, totalEstimado: total },
        },
      });
      step(phase === "merging" ? "🧬" : "🧩", `${message} · ${percent}%`);
    };

    const rowsArr: any[] = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    const rowCount = rowsArr.length;
    // Batching AUTOMÁTICO por tamanho: o plano de partes é calculado por peso e, se der mais de
    // uma parte (peso total > maxBatchWeight), o relatório é gerado em lotes — sem opt-in por
    // relatório. `SUPPORTS_BATCHING` virou OPT-OUT: relatórios com TOTAL GERAL entre linhas
    // (batear em partes independentes daria total parcial) exportam `SUPPORTS_BATCHING = false`
    // para forçar passada única. `getBatchWeight`/`BATCH_MAX_WEIGHT` seguem ajustando o corte.
    const batchingDisabled = renderEngineModule.SUPPORTS_BATCHING === false;
    const envBatchWeight =
      Number(process.env.REPORT_BATCH_MAX_WEIGHT) || Number(process.env.REPORT_BATCH_SIZE);
    const maxBatchWeight = Math.max(
      1,
      envBatchWeight || Number(renderEngineModule.BATCH_MAX_WEIGHT) || 400,
    );
    const getBatchWeight: ReportBatchWeight =
      typeof renderEngineModule.getBatchWeight === "function"
        ? renderEngineModule.getBatchWeight
        : () => 1;
    // Opção B — total geral batch-safe: se a view expõe `computeTotals(rows)`, o total do
    // documento é calculado UMA vez sobre TODAS as linhas (barato, só agregação — sem HTML nem
    // Chromium) e injetado em cada parte via `totals`, com `isLastBatch` para a view renderizar a
    // seção de total só na última parte. Assim relatórios com TOTAL GERAL bateiam com o total certo.
    const computeTotals =
      typeof renderEngineModule.computeTotals === "function"
        ? (renderEngineModule.computeTotals as (rows: readonly any[]) => unknown)
        : null;
    // PDFs prontos anexados pela view (`getPdfAttachments`): o `after-group` corta a parte no fim
    // do grupo, para o anexo entrar entre partes. Ver pdfAttachments.ts.
    const getPdfAttachments: ReportGetPdfAttachments | undefined =
      typeof renderEngineModule.getPdfAttachments === "function"
        ? renderEngineModule.getPdfAttachments
        : undefined;
    const getGroupKey: ReportGetGroupKey | undefined =
      typeof renderEngineModule.getGroupKey === "function"
        ? renderEngineModule.getGroupKey
        : undefined;
    const attachmentCuts =
      getPdfAttachments && !batchingDisabled
        ? buildAttachmentCuts(rowsArr, getPdfAttachments, getGroupKey)
        : new Set<number>();
    const batchPlan = batchingDisabled
      ? []
      : planReportBatches(rowsArr, maxBatchWeight, getBatchWeight, (index) =>
          attachmentCuts.has(index),
        );

    // Streaming de dados: o main já fatiou as linhas em arquivos de página (`options.pageFiles`),
    // então o worker lê UMA página por vez do disco (memória constante, sem os GBs em `data`).
    // Sem streaming, fatia o array em memória (batchPlan). Ambos caem no MESMO caminho de lotes.
    const pageFiles: string[] | undefined = Array.isArray(options.pageFiles)
      ? options.pageFiles
      : undefined;
    const streaming = !!pageFiles && pageFiles.length > 0;

    // O plano dos anexos sai ANTES de as linhas serem soltas parte a parte. Em streaming vem do
    // main. Com o lote desligado (SUPPORTS_BATCHING = false) não há fronteira no meio do
    // documento: o `after-group` vai para depois da passada única.
    const passadaUnica = [{ start: 0, end: rowsArr.length, weight: rowsArr.length }];
    const attachmentPlan: ReportPdfAttachmentPlan | undefined = streaming
      ? options.attachmentPlan
      : getPdfAttachments
        ? planPdfAttachments(
            rowsArr,
            batchPlan.length > 1 ? batchPlan : passadaUnica,
            getPdfAttachments,
            getGroupKey,
          )
        : undefined;
    if (batchingDisabled && attachmentPlan?.afterPart.some((lista) => lista.length > 0)) {
      step("⚠️", "SUPPORTS_BATCHING = false: os PDFs anexados after-group entram no fim.");
    }
    // O arquivo `temporary` é da engine a partir daqui: sai no `finally`, com sucesso ou falha.
    for (const anexo of [
      ...(attachmentPlan?.start ?? []),
      ...(attachmentPlan?.afterPart.flat() ?? []),
      ...(attachmentPlan?.end ?? []),
    ]) {
      if (anexo.temporary) temporaryPaths.add(anexo.path);
    }

    /** Valida (e corta em `maxPages`) cada anexo; o que não abre fica de fora. */
    const resolveAttachmentPlan = async (): Promise<ReportPdfAttachmentPlan<string>> => {
      const resolve = async (lista: ReportPdfAttachmentPlan["start"]) => {
        const caminhos: string[] = [];
        for (const anexo of lista) {
          const pronto = await prepareAttachmentFile(anexo, reportDir, jobId);
          if (!pronto) continue;
          if (pronto.temporary) temporaryPaths.add(pronto.path);
          caminhos.push(pronto.path);
        }
        return caminhos;
      };
      const plano = attachmentPlan ?? { start: [], afterPart: [], end: [] };
      const afterPart: string[][] = [];
      for (const lista of plano.afterPart) afterPart.push(await resolve(lista));
      return { start: await resolve(plano.start), afterPart, end: await resolve(plano.end) };
    };

    // ──────────────────────────────────────────────────────────────────────────
    // GERAÇÃO EM LOTES (automática): o render pondera cada registro por parcelas/páginas.
    // Cada lote vira um PDF em disco; pdfunite faz a junção fora do heap.
    // ──────────────────────────────────────────────────────────────────────────
    if (streaming || batchPlan.length > 1) {
      const totalPartes = streaming ? pageFiles!.length : batchPlan.length;
      step(
        "🧱",
        streaming
          ? `Documento grande (streaming) → ${totalPartes} parte(s) já fatiadas em disco.`
          : `Documento grande (${rowsArr.length} registros) → ${totalPartes} parte(s), peso máximo ${maxBatchWeight}.`,
      );
      startHeartbeat();

      const browser = await getBrowser();
      step("🌐", "Chrome quente pronto.");
      const partPaths: string[] = [];
      let mergedParts = 0;
      // Só reescrevemos a numeração quando o relatório usa o rodapé do Chromium (onde nasce a
      // numeração por-parte). Relatórios que desabilitam header/footer (ex.: carnê) não têm
      // rodapé para corrigir — não carimbamos número onde não havia.
      let usesFooter = false;
      // Total geral: streaming vem pré-calculado do main (options.totals); em memória, calcula aqui
      // sobre TODAS as linhas ANTES de fatiar/liberar (Opção B — reusa o mesmo computeTotals).
      const batchTotals = streaming
        ? options.totals
        : computeTotals
          ? computeTotals(rowsArr)
          : undefined;
      for (let b = 0; b < totalPartes; b++) {
        const range = streaming ? null : batchPlan[b];
        const batchRows: any[] = streaming
          ? JSON.parse(readFileSync(pageFiles![b]!, "utf-8"))
          : rowsArr.slice(range!.start, range!.end);
        emitProgress("generating", b + 1, totalPartes, `Gerando parte ${b + 1} de ${totalPartes}`);
        let { html: partHtml, disableHeaderFooter } = await buildReportHTML({
          rows: batchRows,
          header: headerData,
          title,
          filters,
          jobId,
          orderByFunction,
          assinaturas,
          templateSource,
          // Opção B: total geral pré-calculado + flag da última parte (a view mostra o total só nela).
          totals: batchTotals,
          isLastBatch: b === totalPartes - 1,
        });
        usesFooter = !disableHeaderFooter;
        const partHtmlPath = `${reportDir}/${jobId}.part${b}.html`;
        const partPdfPath = `${reportDir}/${jobId}.part${b}.pdf`;
        writeFileSync(partHtmlPath, partHtml);
        temporaryPaths.add(partHtmlPath);
        temporaryPaths.add(partPdfPath);

        const htmlBytes = Buffer.byteLength(partHtml, "utf8");
        // O HTML já não depende dos objetos de entrada. Solta imediatamente as linhas
        // processadas e a string antes de aguardar o navegador.
        if (streaming) {
          try {
            unlinkSync(pageFiles![b]!); // página consumida — remove do disco
          } catch {
            // já removida — ignora
          }
        } else {
          for (let i = range!.start; i < range!.end; i++) rowsArr[i] = undefined;
        }
        batchRows.length = 0;
        partHtml = "";
        collectGarbage();

        // parte com rodapé → esconde o número do Chromium (pageNumbers.ts reescreve contínuo depois).
        const partPdfBytes = await renderHtmlFileToPdf(
          browser,
          partHtmlPath,
          partPdfPath,
          disableHeaderFooter,
          !disableHeaderFooter,
        );
        partPaths.push(partPdfPath);
        step(
          "📑",
          `Parte ${b + 1}/${totalPartes} pronta: HTML ${fmtBytes(htmlBytes)}, PDF ${fmtBytes(partPdfBytes)}.`,
        );
        collectGarbage();
      }
      mergedParts = partPaths.length;

      // Numeração CONTÍNUA antes do merge: reescreve "Página X de Y" em cada parte (arquivos
      // pequenos → memória baixa) para a numeração não reiniciar por parte. Ver pageNumbers.ts.
      // Só quando o relatório usa o rodapé do Chromium (carnê e afins ficam de fora).
      if (usesFooter) {
        emitProgress("merging", 0, 1, `Numerando ${totalPartes} partes`);
        await stampContinuousPageNumbers(partPaths);
        step("🔢", "Numeração contínua aplicada nas partes.");
      }

      const pdfPath = `${reportDir}/${jobId}.pdf`;
      const mergingPath = `${reportDir}/${jobId}.merging.pdf`;
      if (existsSync(pdfPath)) unlinkSync(pdfPath);
      if (existsSync(mergingPath)) unlinkSync(mergingPath);
      temporaryPaths.add(mergingPath);
      emitProgress("merging", 0, 1, `Mesclando ${totalPartes} partes em disco`);
      await mergePdfParts(buildMergeOrder(partPaths, await resolveAttachmentPlan()), mergingPath);
      renameSync(mergingPath, pdfPath);
      temporaryPaths.delete(mergingPath);
      emitProgress("merging", 1, 1, `Mesclagem de ${totalPartes} partes concluída`);
      const finalBytes = statSync(pdfPath).size;
      step("💽", `PDF final salvo: ${pdfPath} (${fmtBytes(finalBytes)}, ${totalPartes} parte(s)).`);

      for (const p of partPaths) {
        try {
          unlinkSync(p);
          temporaryPaths.delete(p);
        } catch {
          // parte já removida — ignora
        }
      }

      stopHeartbeat();
      canal.postMessage({
        jobId,
        success: true,
        result: { parts: mergedParts, bytes: finalBytes },
      });
      step("🎉", `Job concluído com sucesso (${totalPartes} parte(s)) — aguardando próximo job.`);
      return;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PASSADA ÚNICA (só quando cabe em 1 parte OU o relatório optou por não batear).
    // ──────────────────────────────────────────────────────────────────────────
    step("🧩", `Gerando HTML do relatório (${rowCount} registro(s))…`);
    let { html, disableHeaderFooter } = await buildReportHTML({
      rows: data,
      header: headerData,
      title,
      filters,
      jobId,
      orderByFunction,
      assinaturas,
      templateSource,
    });

    const htmlBytes = Buffer.byteLength(html, "utf8");
    step("📄", `HTML gerado: ${fmtBytes(htmlBytes)} (${rowCount} registro(s)).`);
    if (htmlBytes > 200 * 1024 * 1024) {
      step(
        "🚨",
        `HTML MUITO GRANDE (${fmtBytes(htmlBytes)}) em passada única. Este relatório optou por não batear ` +
          `(SUPPORTS_BATCHING=false) — se ele NÃO tem total geral entre linhas, remova o opt-out para batear automaticamente.`,
      );
    }

    const htmlPath = `${reportDir}/${jobId}.html`;
    const pdfPath = `${reportDir}/${jobId}.pdf`;
    writeFileSync(htmlPath, html);
    temporaryPaths.add(htmlPath);
    // Depois que o HTML foi materializado, os registros e a string não precisam
    // ficar vivos durante page.goto()/page.pdf().
    for (let i = 0; i < rowsArr.length; i++) rowsArr[i] = undefined;
    html = "";
    collectGarbage();

    startHeartbeat();
    step("🌐", `Usando Chrome quente: ${USE_FIREFOX ? "Firefox" : "Chromium"}…`);
    const browser = await getBrowser();
    step("🌐", "Chrome pronto. Renderizando PDF (pode demorar em documentos grandes)…");

    let pdfBytes = await renderHtmlFileToPdf(browser, htmlPath, pdfPath, disableHeaderFooter);
    step("💽", `PDF salvo: ${pdfPath} (${fmtBytes(pdfBytes)}).`);

    // Passada única com PDFs anexados: junta o relatório com eles, na ordem do plano.
    if (attachmentPlan && hasPdfAttachments(attachmentPlan)) {
      const anexos = await resolveAttachmentPlan();
      if (hasPdfAttachments(anexos)) {
        const mergingPath = `${reportDir}/${jobId}.merging.pdf`;
        temporaryPaths.add(mergingPath);
        await mergePdfParts(buildMergeOrder([pdfPath], anexos), mergingPath);
        renameSync(mergingPath, pdfPath);
        temporaryPaths.delete(mergingPath);
        pdfBytes = statSync(pdfPath).size;
        step("📎", `PDFs anexados juntados ao relatório (${fmtBytes(pdfBytes)}).`);
      }
    }

    stopHeartbeat();
    canal.postMessage({ jobId, success: true, result: { parts: 1, bytes: pdfBytes } });
    step("🎉", "Job concluído com sucesso — aguardando próximo job.");
  } catch (error) {
    stopHeartbeat();
    const message = (error as Error)?.message || "Unknown error in worker";
    console.error(
      `[REPORT:WORKER][${jobId}] ❌ Job FALHOU após ${fmtMs(Date.now() - startedAt)}: ${message}`,
    );
    console.error(error);
    canal.postMessage({ jobId, error: message });
  } finally {
    stopHeartbeat();
    for (const path of temporaryPaths) {
      try {
        unlinkSync(path);
      } catch {
        // Limpeza idempotente: o arquivo pode ter sido removido no fluxo feliz.
      }
    }
    temporaryPaths.clear();
    // Varredura garantida por prefixo do job, preservando o PDF final.
    if (options?.outputDir) removeJobArtifacts(options.outputDir, jobId);
    options.data = undefined;
    collectGarbage();
  }
}

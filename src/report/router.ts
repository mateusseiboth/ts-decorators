import { unlink } from "fs";

import { Router, type Request, type Response } from "express";

import { getReportEngine } from "./config";
import type { ReportEngine } from "./ReportEngine";
import type { ReportDefinition, ReportQueueView, ReportUser } from "./types";

export interface ReportRouterOptions {
  /** Default: getReportEngine(). */
  engine?: ReportEngine;
  /**
   * Carrega (e RESOLVE) a definição do relatório — é aqui que o app aplica a
   * resolução de modelos por entidade (config → linha da entidade → global).
   */
  loadDefinition(id: string, req: Request): Promise<ReportDefinition | null>;
  /** Usuário/entidade do contexto do app (ALS/res.locals). */
  buildUser(req: Request): ReportUser;
  /** Default: header "exercicio" → body.exercicio → ano atual. */
  resolveExercicio?: (req: Request) => number;
  /** Default: query.format → body.format → "pdf". */
  resolveFormat?: (req: Request) => string;
  /** Apaga o arquivo após o download. Default: true (contrato atual). */
  deleteAfterDownload?: boolean;
  /** Default: o da engine (203). */
  enqueueStatusCode?: number;
  /** Mapeia a view canônica para o shape que o frontend legado espera. */
  mapQueueView?: (view: ReportQueueView) => unknown;
}

function defaultExercicio(req: Request): number {
  const fromHeader = Number(req.headers["exercicio"]);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;
  const fromBody = Number((req.body as any)?.exercicio);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  return new Date().getFullYear();
}

function defaultFormat(req: Request): string {
  return String(req.query.format ?? (req.body as any)?.format ?? "pdf");
}

/**
 * Router factory da engine — o app monta com seus PRÓPRIOS middlewares de
 * auth/permissão (nada de bypass no pacote):
 *
 *   app.use("/relatorio/api", authMiddleware, createReportRouter({...}))
 *
 * Rotas: POST /forge/:id · GET /queue/status/:id · GET /queue/user ·
 * GET /download/:id · POST /data/:id (síncrona, Studio) · CRUD /templates.
 */
export function createReportRouter(options: ReportRouterOptions): Router {
  const router = Router();
  const engine = () => options.engine ?? getReportEngine();
  const resolveExercicio = options.resolveExercicio ?? defaultExercicio;
  const resolveFormat = options.resolveFormat ?? defaultFormat;
  const mapQueueView = options.mapQueueView ?? ((view: ReportQueueView) => view);
  const deleteAfterDownload = options.deleteAfterDownload !== false;

  router.post("/forge/:id", async (req: Request, res: Response) => {
    try {
      const definition = await options.loadDefinition(String(req.params.id), req);
      if (!definition) {
        res.status(404).json({ message: "Relatório não encontrado." });
        return;
      }

      const view = await engine().enqueue({
        definition,
        filters: (req.body as Record<string, unknown>) ?? {},
        exercicio: resolveExercicio(req),
        format: resolveFormat(req),
        user: options.buildUser(req),
      });

      res.status(options.enqueueStatusCode ?? engine().enqueueStatusCode).json({
        message: "Relatório enfileirado para geração.",
        data: {
          id: view.id,
          position: view.position,
          queueSize: view.queueSize,
          status: view.status,
        },
      });
    } catch (error: any) {
      res.status(500).json({ message: error?.message ?? "Erro ao enfileirar relatório." });
    }
  });

  router.get("/queue/status/:id", (req: Request, res: Response) => {
    const view = engine().getStatus(String(req.params.id));
    if (!view) {
      res.status(404).json({ message: "Job não encontrado." });
      return;
    }
    res.json({ data: mapQueueView(view) });
  });

  router.get("/queue/user", (req: Request, res: Response) => {
    const user = options.buildUser(req);
    const views = engine().getUserJobs(user.id, user.entidade);
    res.json({ data: views.map(mapQueueView) });
  });

  router.get("/download/:id", (req: Request, res: Response) => {
    const file = engine().getResultFile(String(req.params.id));
    if (!file) {
      res.status(404).json({ message: "Arquivo do relatório não encontrado." });
      return;
    }

    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename=${file.filename}`);
    res.sendFile(file.path, (err) => {
      if (err) {
        console.error(`[REPORT] Erro no download de ${file.path}:`, err);
        return;
      }
      if (deleteAfterDownload) {
        unlink(file.path, () => undefined);
      }
    });
  });

  /**
   * SÍNCRONA: dados TRATADOS da view (buildReportData) direto na resposta.
   * Uso previsto: Studio/integrações em dev — relatórios gigantes devem filtrar.
   */
  router.post("/data/:id", async (req: Request, res: Response) => {
    try {
      const definition = await options.loadDefinition(String(req.params.id), req);
      if (!definition) {
        res.status(404).json({ message: "Relatório não encontrado." });
        return;
      }

      const viewModel = await engine().buildViewModel({
        definition,
        filters: (req.body as Record<string, unknown>) ?? {},
        exercicio: resolveExercicio(req),
        user: options.buildUser(req),
      });
      res.json(
        JSON.parse(
          JSON.stringify(viewModel, (_key, value) =>
            typeof value === "bigint" ? Number(value) : value,
          ),
        ),
      );
    } catch (error: any) {
      res.status(500).json({ message: error?.message ?? "Erro ao montar dados do relatório." });
    }
  });

  // ── Templates (Studio) ─────────────────────────────────────────────────────

  router.post("/templates/:reportId", async (req: Request, res: Response) => {
    const { name, content } = (req.body as { name?: string; content?: string }) ?? {};
    if (!name || !content) {
      res.status(400).json({ message: "name e content são obrigatórios." });
      return;
    }
    const template = await engine().templateStore.save(String(req.params.reportId), {
      name,
      content,
    });
    res.status(201).json({ data: template });
  });

  router.get("/templates/:reportId", async (req: Request, res: Response) => {
    const templates = await engine().templateStore.list(String(req.params.reportId));
    res.json({ data: templates });
  });

  router.put("/templates/:reportId/active/:templateId", async (req: Request, res: Response) => {
    await engine().templateStore.setActive(
      String(req.params.reportId),
      String(req.params.templateId),
    );
    res.json({ message: "Template ativado." });
  });

  router.delete("/templates/:reportId/active", async (req: Request, res: Response) => {
    await engine().templateStore.setActive(String(req.params.reportId), null);
    res.json({ message: "Template padrão restaurado." });
  });

  return router;
}

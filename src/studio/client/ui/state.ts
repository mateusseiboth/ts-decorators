/** Estado compartilhado do Studio e um barramento mínimo de eventos entre os painéis. */
import type { HelperDocLike } from "../logic/completion";
import { collectLists, describeData, type ListInfo, type SchemaNode } from "../logic/dataSchema";
import type { Connection, Problem, Starter } from "./api";
import { readItem, readJson, writeJson } from "./storage";

export const SAMPLE_DATA = {
  titulo: "Relatório de exemplo",
  responsavel: "Setor de Qualidade",
  itens: [
    { nome: "Item A", categoria: "Insumo", valor: 150.5, quantidade: 3 },
    { nome: "Item B", categoria: "Serviço", valor: 89.9, quantidade: 1 },
    { nome: "Item C", categoria: "Insumo", valor: 42, quantidade: 7 },
  ],
};

export interface StudioState {
  data: unknown;
  schema: SchemaNode[];
  lists: ListInfo[];
  helpers: HelperDocLike[];
  starters: Starter[];
  problems: Problem[];
  connection: Connection;
  filters: string;
}

export const state: StudioState = {
  data: {},
  schema: [],
  lists: [],
  helpers: [],
  starters: [],
  problems: [],
  connection: { baseUrl: "", reportId: "", headers: {} },
  filters: "{}",
};

type StudioEvent = "data" | "problems" | "connection";
const listeners = new Map<StudioEvent, Set<() => void>>();

export function on(event: StudioEvent, listener: () => void): void {
  const set = listeners.get(event) ?? new Set();
  set.add(listener);
  listeners.set(event, set);
}

function emit(event: StudioEvent): void {
  for (const listener of listeners.get(event) ?? []) listener();
}

export function setData(data: unknown): void {
  state.data = data ?? {};
  state.schema = describeData(state.data);
  state.lists = collectLists(state.schema);
  writeJson("data", state.data);
  emit("data");
}

export function setProblems(problems: Problem[]): void {
  state.problems = problems;
  emit("problems");
}

export function setConnection(connection: Connection, filters: string): void {
  state.connection = connection;
  state.filters = filters;
  writeJson("connection", { ...connection, filters });
  emit("connection");
}

export const isConnected = () =>
  Boolean(state.connection.baseUrl.trim() && state.connection.reportId.trim());

/** Conexão salva; migra o formato antigo, que guardava a URL inteira da rota de dados. */
export function restoreConnection(): void {
  const saved = readJson<(Connection & { filters?: string }) | null>("connection", null);
  if (saved) {
    setConnection(
      {
        baseUrl: saved.baseUrl ?? "",
        reportId: saved.reportId ?? "",
        headers: saved.headers ?? {},
      },
      saved.filters ?? "{}",
    );
    return;
  }
  const match = /^(.*)\/data\/([^/]+)\/?$/.exec(readItem("dataUrl").trim());
  const headers = readJson<Record<string, string>>("headersJson", {});
  const filters = JSON.stringify(readJson<unknown>("filtersJson", {}));
  setConnection({ baseUrl: match?.[1] ?? "", reportId: match?.[2] ?? "", headers }, filters);
}

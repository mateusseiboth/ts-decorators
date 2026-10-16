/**
 * Rotas montadas pelo `folderRouter`, com os endpoints (verbo + caminho) de cada uma.
 *
 * Existe por dois motivos: o health check do sistema precisa saber o que está no ar (a lista só
 * era impressa no log), e o log de boot vira UMA tabela em vez de uma linha `[ROUTE]` por pasta.
 */
import type { Router } from "express";

export interface RegisteredEndpoint {
  method: string;
  path: string;
}

export interface RegisteredRoute {
  /** Caminho de montagem (`/api/v1/cobranca/baixa`). */
  path: string;
  endpoints: RegisteredEndpoint[];
}

const _routes: RegisteredRoute[] = [];

export function recordRoute(route: RegisteredRoute): void {
  _routes.push(route);
}

/** Cópia do registro, na ordem de montagem. */
export function getRegisteredRoutes(): RegisteredRoute[] {
  return _routes.map((route) => ({ ...route, endpoints: [...route.endpoints] }));
}

export function clearRegisteredRoutes(): void {
  _routes.length = 0;
}

interface RouteLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
}

/** `_all` é o `.all()` do Express: vale para qualquer verbo. */
const rotuloDoVerbo = (method: string): string =>
  method === "_all" ? "ALL" : method.toUpperCase();

/** Endpoints declarados no router (só as camadas com rota; middleware solto não conta). */
export function endpointsOf(router: Router): RegisteredEndpoint[] {
  const stack = (router as unknown as { stack?: RouteLayer[] }).stack ?? [];
  return stack.flatMap((layer) => {
    if (!layer.route) return [];
    const caminhos = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    const verbos = Object.keys(layer.route.methods).filter((verbo) => layer.route!.methods[verbo]);
    return caminhos.flatMap((caminho) =>
      verbos.map((verbo) => ({ method: rotuloDoVerbo(verbo), path: String(caminho) })),
    );
  });
}

/** Ordem fixa dos verbos na coluna: a tabela não muda de uma subida para outra. */
const ORDEM_DOS_VERBOS = ["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"];

const verbosDa = (route: RegisteredRoute): string => {
  const usados = new Set(route.endpoints.map((endpoint) => endpoint.method));
  const conhecidos = ORDEM_DOS_VERBOS.filter((verbo) => usados.has(verbo));
  const outros = [...usados].filter((verbo) => !ORDEM_DOS_VERBOS.includes(verbo)).sort();
  return [...conhecidos, ...outros].join(" ");
};

const TITULOS = ["Rota", "End", "Verbos"] as const;

/** Largura mínima da coluna de verbos: a tabela não encolhe quando só há GET. */
const LARGURA_MINIMA_DOS_VERBOS = 11;

type Linha = [rota: string, quantidade: string, verbos: string];

const larguraDa = (linhas: Linha[], coluna: 0 | 1 | 2): number =>
  Math.max(TITULOS[coluna].length, ...linhas.map((linha) => linha[coluna].length));

/** Tabela das rotas para o log de boot: rota, quantidade de endpoints e verbos usados. */
export function formatRoutesTable(routes: RegisteredRoute[]): string[] {
  if (routes.length === 0) return [];

  const total = routes.reduce((soma, route) => soma + route.endpoints.length, 0);
  const linhas: Linha[] = routes.map((route) => [
    route.path,
    String(route.endpoints.length),
    verbosDa(route),
  ]);
  const rodape: Linha = [
    `${routes.length} rota${routes.length === 1 ? "" : "s"}`,
    String(total),
    "",
  ];

  const todas = [...linhas, rodape];
  const larguras: [number, number, number] = [
    larguraDa(todas, 0),
    larguraDa(todas, 1),
    Math.max(larguraDa(todas, 2), LARGURA_MINIMA_DOS_VERBOS),
  ];

  const borda = (esquerda: string, meio: string, direita: string) =>
    esquerda + larguras.map((largura) => "─".repeat(largura + 2)).join(meio) + direita;
  const linha = ([rota, quantidade, verbos]: Linha) =>
    `│ ${rota.padEnd(larguras[0])} │ ${quantidade.padStart(larguras[1])} │ ${verbos.padEnd(larguras[2])} │`;

  return [
    borda("┌", "┬", "┐"),
    linha([...TITULOS]),
    borda("├", "┼", "┤"),
    ...linhas.map(linha),
    borda("├", "┼", "┤"),
    linha(rodape),
    borda("└", "┴", "┘"),
  ];
}

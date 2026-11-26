/**
 * Registro de ações do Studio: fonte única para os botões (`data-action`), os atalhos do teclado,
 * a paleta de comandos (Ctrl+K) e a tela de atalhos (F1).
 */
export interface Action {
  id: string;
  label: string;
  group: string;
  /** Atalho para exibição e disparo, ex.: "Ctrl+Shift+P". */
  keys?: string;
  run: () => void | Promise<void>;
}

const actions = new Map<string, Action>();
const byKeys = new Map<string, Action>();

const normalizeKeys = (keys: string) => keys.toLowerCase().replaceAll(" ", "");

export function defineActions(list: readonly Action[]): void {
  for (const action of list) {
    actions.set(action.id, action);
    if (action.keys) byKeys.set(normalizeKeys(action.keys), action);
  }
}

export function runAction(id: string): void {
  void actions.get(id)?.run();
}

export const listActions = () => [...actions.values()];

function keysOf(event: KeyboardEvent): string {
  const parts = [
    event.ctrlKey || event.metaKey ? "ctrl" : "",
    event.altKey ? "alt" : "",
    event.shiftKey ? "shift" : "",
    event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase(),
  ];
  return parts.filter(Boolean).join("+");
}

/** Atalhos globais. Devolve true quando consumiu a tecla. */
export function dispatchShortcut(event: KeyboardEvent): boolean {
  const action = byKeys.get(keysOf(event));
  if (!action) return false;
  event.preventDefault();
  void action.run();
  return true;
}

export function bindActionButtons(root: ParentNode = document): void {
  root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (button?.dataset.action) runAction(button.dataset.action);
  });
}

/** Utilitários de DOM do Studio: busca por id, construção de elementos, toast, status e diálogos. */

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Elemento #${id} não existe na página do Studio.`);
  return element as T;
}

export const inputById = (id: string) => byId<HTMLInputElement>(id);
export const selectById = (id: string) => byId<HTMLSelectElement>(id);
export const textareaById = (id: string) => byId<HTMLTextAreaElement>(id);

type Child = Node | string | null | undefined | false;

interface ElementProps {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.title) element.title = props.title;
  for (const [name, value] of Object.entries(props.attrs ?? {})) element.setAttribute(name, value);
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    element.addEventListener(type, handler as EventListener);
  }
  for (const child of children) {
    if (child) element.append(child);
  }
  return element;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, isError = false): void {
  const element = byId("toast");
  element.textContent = message;
  element.className = isError ? "show err" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.className = ""), isError ? 5000 : 2800);
}

export type StatusState = "idle" | "ok" | "err" | "busy";

export function setStatus(message: string, state: StatusState = "idle"): void {
  byId("status").textContent = message;
  byId("statusDot").className = state === "idle" ? "dot" : `dot ${state}`;
}

export function openDialog(id: string): HTMLDialogElement {
  const dialog = byId<HTMLDialogElement>(id);
  if (!dialog.open) dialog.showModal();
  return dialog;
}

export function closeDialog(id: string): void {
  byId<HTMLDialogElement>(id).close();
}

/** Botões `data-close` fecham o diálogo em que estão. */
export function bindDialogCloseButtons(): void {
  document.addEventListener("click", (event) => {
    const button = (event.target as Element).closest("[data-close]");
    button?.closest("dialog")?.close();
  });
}

export function setError(id: string, message = ""): void {
  byId(id).textContent = message;
}

/** Executa `task` com o botão desabilitado, para não disparar duas vezes. */
export async function withBusyButton(button: HTMLButtonElement, task: () => Promise<void>) {
  button.disabled = true;
  try {
    await task();
  } finally {
    button.disabled = false;
  }
}

export function fillSelect(
  select: HTMLSelectElement,
  options: readonly { value: string; label: string }[],
): void {
  select.replaceChildren(
    ...options.map((o) => h("option", { text: o.label, attrs: { value: o.value } })),
  );
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = h("a", { attrs: { href: url, download: filename } });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

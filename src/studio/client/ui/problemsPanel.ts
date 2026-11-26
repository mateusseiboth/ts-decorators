/** Painel "Problemas": lint do modelo contra os dados, com clique levando à linha. */
import { lintPreview } from "./api";
import { byId, h } from "./dom";
import type { Editor } from "./editor";
import { on, setProblems, state } from "./state";
import { readItem, writeItem } from "./storage";

const LINT_DELAY_MS = 450;

export class ProblemsPanel {
  private readonly pane = byId("problemsPane");
  private readonly list = byId("problems");
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;

  constructor(private readonly editor: Editor) {
    this.pane.classList.toggle("collapsed", readItem("problemsCollapsed") === "1");
    byId("problemsToggle").addEventListener("click", () => this.toggle());
    on("problems", () => this.render());
  }

  toggle(): void {
    const collapsed = this.pane.classList.toggle("collapsed");
    byId("problemsToggle").setAttribute("aria-expanded", String(!collapsed));
    writeItem("problemsCollapsed", collapsed ? "1" : "0");
  }

  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.lint(), LINT_DELAY_MS);
  }

  async lint(): Promise<void> {
    const sequence = ++this.sequence;
    const result = await lintPreview({ template: this.editor.value, data: state.data }).catch(
      () => null,
    );
    if (sequence !== this.sequence || !result?.ok) return;
    setProblems(result.body.problems);
  }

  private render(): void {
    const problems = state.problems;
    const errors = problems.filter((p) => p.severity === "error").length;
    byId("errCount").textContent = String(errors);
    byId("warnCount").textContent = String(problems.length - errors);
    this.editor.setProblems(problems);
    if (!problems.length) {
      this.list.replaceChildren(h("li", { class: "ok", text: "Nenhum problema no modelo." }));
      return;
    }
    this.list.replaceChildren(
      ...problems.map((problem) =>
        h(
          "li",
          {
            class: problem.severity === "error" ? "err" : "warn",
            on: { click: () => this.editor.goTo(problem) },
          },
          h("span", { class: "sev", text: problem.severity === "error" ? "●" : "▲" }),
          h("span", { class: "where", text: `Ln ${problem.line}, Col ${problem.column}` }),
          h("span", { text: problem.message }),
        ),
      ),
    );
  }
}

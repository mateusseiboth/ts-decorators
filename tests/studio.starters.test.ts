import { describe, expect, test } from "bun:test";

import Handlebars from "handlebars";

import { registerDefaultReportHelpers } from "../src/report/templateHelpers";
import { lintTemplate } from "../src/studio/lint";
import { STUDIO_STARTERS } from "../src/studio/starters";

const hbs = Handlebars.create();
registerDefaultReportHelpers(hbs);
hbs.registerPartial("assinaturas", "");

describe("modelos prontos do Studio", () => {
  test("ids são únicos", () => {
    const ids = STUDIO_STARTERS.map((starter) => starter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const starter of STUDIO_STARTERS) {
    test(`${starter.name}: renderiza e não tem problemas com os próprios dados`, () => {
      expect(() => hbs.compile(starter.template)(starter.sampleData)).not.toThrow();
      const problems = lintTemplate(starter.template, {
        data: starter.sampleData,
        helpers: new Set(Object.keys(hbs.helpers)),
        partials: new Set(["assinaturas"]),
      });
      expect(problems).toEqual([]);
    });
  }
});

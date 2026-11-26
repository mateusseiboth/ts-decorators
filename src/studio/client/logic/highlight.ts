/**
 * Realce de sintaxe do editor: devolve o HTML colorido que fica atrás do textarea transparente.
 * Os dois precisam ter a mesma métrica para o texto casar pixel a pixel com o realce.
 */
const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const span = (cls: string, html: string) => `<span class="${cls}">${html}</span>`;

/** Percorre `src` com a regex e escapa o texto entre os matches. */
function paint(src: string, re: RegExp, renderMatch: (match: RegExpExecArray) => string): string {
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  for (let match = re.exec(src); match; match = re.exec(src)) {
    out += escapeHtml(src.slice(last, match.index)) + renderMatch(match);
    last = match.index + match[0].length;
    if (!match[0].length) re.lastIndex++;
  }
  return out + escapeHtml(src.slice(last));
}

const RE_HBS = /\{\{[^]*?\}\}/g;
const RE_MASTER =
  /(\{\{!--[^]*?--\}\}|\{\{![^]*?\}\})|(\{\{[^]*?\}\})|(<!--[^]*?-->)|(<\/?[a-zA-Z][^<>]*>?)/g;
const RE_TAG_PARTS = /^(<\/?)([a-zA-Z][-a-zA-Z0-9]*)([^]*)$/;
const RE_TAG_BODY = /(\{\{[^]*?\}\})|("[^"]*"?|'[^']*'?)|([a-zA-Z_][-a-zA-Z0-9_:.]*)(?=\s*=)/g;
const RE_BLOCK = /^\{\{~?\s*([#/^]|else\b)/;

const hbsSpan = (code: string) =>
  span(RE_BLOCK.test(code) ? "tok-hbs-block" : "tok-hbs", escapeHtml(code));

function tagBodyToken(match: RegExpExecArray): string {
  if (match[1]) return hbsSpan(match[1]);
  // Strings de atributo podem conter {{campo}}: realça por dentro.
  if (match[2])
    return span(
      "tok-str",
      paint(match[2], RE_HBS, (m) => hbsSpan(m[0])),
    );
  return span("tok-attr", escapeHtml(match[3] ?? ""));
}

function tagSpan(tag: string): string {
  const parts = RE_TAG_PARTS.exec(tag);
  if (!parts) return escapeHtml(tag);
  const [, open = "", name = "", body = ""] = parts;
  return (
    span("tok-pun", escapeHtml(open)) +
    span("tok-tag", name) +
    paint(body, RE_TAG_BODY, tagBodyToken)
  );
}

function masterToken(match: RegExpExecArray): string {
  if (match[1]) return span("tok-com", escapeHtml(match[1]));
  if (match[2]) return hbsSpan(match[2]);
  if (match[3]) return span("tok-com", escapeHtml(match[3]));
  return tagSpan(match[4] ?? "");
}

export function highlightTemplate(src: string): string {
  return paint(src, RE_MASTER, masterToken);
}

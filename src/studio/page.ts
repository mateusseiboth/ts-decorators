/**
 * Página única do Studio — editor de templates HBS estilo "Google Docs",
 * pensada para usuários não técnicos (setor de qualidade):
 *
 *  - Barra de ferramentas com formatação (títulos, negrito, alinhamento…).
 *  - Painel de dados: cole um JSON ou carregue do app e ARRASTE os campos
 *    para dentro do editor (ou clique no +) — vira {{campo}} automaticamente.
 *  - Assistentes de tabela, condicional (if) e cálculo (soma/média/…): o
 *    usuário escolhe nas caixas e o Studio escreve o Handlebars sozinho.
 *  - Preview em "folha A4" renderizado no servidor local (POST /api/render),
 *    com os MESMOS helpers do worker de PDF. Auto-contida, sem CDN.
 *
 * O iframe usa sandbox="allow-scripts allow-same-origin" — templates de
 * relatório carregam <script> próprios e sem a permissão o Chrome bloqueia
 * ("Blocked script execution in 'about:srcdoc'…").
 */
export function studioPage(): string {
  return /* html */ `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>ts-decorators Studio</title>
<style>
  :root {
    --bg: #f1f3f4;
    --surface: #ffffff;
    --border: #dadce0;
    --text: #202124;
    --muted: #5f6368;
    --primary: #1a73e8;
    --primary-dark: #185abc;
    --green: #188038;
    --amber: #b06000;
    --purple: #7627bb;
    --danger: #d93025;
    --radius: 8px;
    --shadow: 0 1px 3px rgba(60,64,67,.2);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; font-family: "Segoe UI", Roboto, system-ui, sans-serif;
    font-size: 14px; color: var(--text); background: var(--bg);
    display: flex; flex-direction: column; overflow: hidden;
  }
  button { font-family: inherit; }

  /* ── Barra superior ─────────────────────────────────────────────────── */
  #appbar {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border);
  }
  #logo { width: 34px; height: 34px; border-radius: 8px; background: linear-gradient(135deg,#1a73e8,#7627bb);
    display: grid; place-items: center; color: #fff; font-size: 17px; flex: none; }
  #docName {
    font-size: 16px; font-weight: 500; border: 1px solid transparent; border-radius: 4px;
    padding: 4px 8px; min-width: 220px; color: var(--text); background: transparent;
  }
  #docName:hover { border-color: var(--border); }
  #docName:focus { outline: 2px solid var(--primary); border-color: transparent; }
  #appbar .spacer { flex: 1; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px;
    border-radius: 6px; border: 1px solid var(--border); background: var(--surface);
    color: var(--text); font-size: 13px; cursor: pointer; white-space: nowrap;
  }
  .btn:hover { background: #f8f9fa; box-shadow: var(--shadow); }
  .btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 500; }
  .btn.primary:hover { background: var(--primary-dark); }

  /* ── Barra de ferramentas ───────────────────────────────────────────── */
  #toolbar {
    display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
    padding: 6px 12px; background: var(--surface); border-bottom: 1px solid var(--border);
  }
  .tb {
    border: 0; background: transparent; border-radius: 6px; min-width: 32px; height: 32px;
    padding: 0 8px; font-size: 14px; color: var(--text); cursor: pointer;
    display: inline-flex; align-items: center; gap: 5px;
  }
  .tb:hover { background: #e8eaed; }
  .tb b { font-weight: 700; }
  .tb.wizard { color: var(--primary-dark); font-weight: 500; font-size: 13px; }
  .tb-sep { width: 1px; height: 22px; background: var(--border); margin: 0 6px; flex: none; }
  .tb-group-label { font-size: 11px; color: var(--muted); margin: 0 4px 0 2px; }
  #viewToggle { margin-left: auto; display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  #viewToggle .tb { border-radius: 0; height: 28px; font-size: 12px; }
  #viewToggle .tb.active { background: #e8f0fe; color: var(--primary-dark); font-weight: 600; }

  /* Menus suspensos da toolbar */
  .menu-wrap { position: relative; }
  .menu {
    position: absolute; top: 36px; left: 0; z-index: 50; min-width: 270px; max-height: 340px; overflow: auto;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: 0 4px 16px rgba(60,64,67,.28); padding: 6px; display: none;
  }
  .menu.open { display: block; }
  .menu .mi {
    display: block; width: 100%; text-align: left; border: 0; background: transparent;
    padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 13px;
  }
  .menu .mi:hover { background: #e8f0fe; }
  .menu .mi small { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; }
  .menu .mi code { font-size: 11px; color: var(--purple); }
  .menu h5 { margin: 6px 10px 2px; font-size: 11px; text-transform: uppercase; color: var(--muted); }

  /* ── Corpo ──────────────────────────────────────────────────────────── */
  main { flex: 1; display: flex; min-height: 0; }

  /* Painel de dados */
  #sidebar {
    width: 280px; flex: none; background: var(--surface); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; min-height: 0;
  }
  #sidebar header {
    padding: 10px 12px; font-weight: 600; font-size: 13px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
  }
  #sidebar header .btn { padding: 4px 8px; font-size: 12px; }
  #dataTree { flex: 1; overflow: auto; padding: 8px; }
  #dataTree .hint { color: var(--muted); font-size: 12px; padding: 12px; line-height: 1.5; }
  .node { margin: 1px 0; }
  .node-row {
    display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px;
    cursor: grab; font-size: 12.5px; user-select: none;
  }
  .node-row:hover { background: #e8f0fe; }
  .node-row:hover .node-add { visibility: visible; }
  .node-row .key { font-weight: 500; }
  .node-row .type {
    font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #e8eaed; color: var(--muted); flex: none;
  }
  .node-row .type.arr { background: #e6f4ea; color: var(--green); }
  .node-row .type.num { background: #fef7e0; color: var(--amber); }
  .node-row .sample { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .node-add {
    visibility: hidden; border: 0; background: var(--primary); color: #fff; border-radius: 50%;
    width: 18px; height: 18px; font-size: 13px; line-height: 1; cursor: pointer; flex: none;
  }
  .node-children { margin-left: 14px; border-left: 1px dotted var(--border); padding-left: 6px; }
  .node-caret { border: 0; background: transparent; cursor: pointer; width: 14px; padding: 0; color: var(--muted); flex: none; }
  #dragTip { padding: 8px 12px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); background: #f8f9fa; }

  /* Editor — textarea transparente sobre um <pre> colorido (overlay).
     Os dois PRECISAM ter métrica idêntica (fonte, padding, wrap) para o
     texto digitado casar pixel a pixel com o realce atrás. */
  #editorPane { flex: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); }
  #editorPane .pane-title { padding: 6px 12px; font-size: 11px; text-transform: uppercase; color: var(--muted); background: #f8f9fa; border-bottom: 1px solid var(--border); }
  #editorWrap { position: relative; flex: 1; min-height: 0; background: #fbfcfd; }
  #editorWrap.dropping { background: #e8f0fe; }
  #editorHl, #editor {
    position: absolute; inset: 0; margin: 0; border: 0; padding: 14px 16px;
    font-family: "Cascadia Code", ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.55;
    white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; tab-size: 2;
  }
  #editorHl { overflow: hidden; pointer-events: none; color: #24292f; }
  #editorHl code { font: inherit; white-space: inherit; overflow-wrap: inherit; }
  #editor {
    resize: none; outline: none; overflow: auto;
    background: transparent; color: transparent; caret-color: #1f2328;
  }
  #editor::placeholder { color: #9aa0a6; }
  #editor::selection { background: rgba(26,115,232,.22); }
  .tok-tag { color: #116329; font-weight: 600; }
  .tok-pun { color: #57606a; }
  .tok-attr { color: #953800; }
  .tok-str { color: #0a3069; }
  .tok-com { color: #6e7781; font-style: italic; }
  .tok-hbs { color: #8250df; font-weight: 600; }
  .tok-hbs-block { color: #cf222e; font-weight: 700; }

  /* Preview */
  #previewPane { flex: 1.15; min-width: 0; display: flex; flex-direction: column; background: var(--bg); }
  #previewPane .pane-title {
    padding: 6px 12px; font-size: 11px; text-transform: uppercase; color: var(--muted);
    background: #f8f9fa; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px;
  }
  #zoom { margin-left: auto; font-size: 12px; border: 1px solid var(--border); border-radius: 4px; padding: 2px 4px; }
  #paperScroll { flex: 1; overflow: auto; padding: 24px; }
  #paper {
    width: 794px; min-height: 1123px; margin: 0 auto; background: #fff;
    box-shadow: 0 1px 3px rgba(60,64,67,.3), 0 4px 8px rgba(60,64,67,.15);
    transform-origin: top center;
  }
  #preview { width: 794px; height: 1123px; border: 0; display: block; }
  #renderError {
    display: none; margin: 0 24px 12px; padding: 10px 14px; border-radius: 6px;
    background: #fce8e6; color: var(--danger); font-size: 12.5px; font-family: ui-monospace, monospace;
  }
  #renderError.show { display: block; }

  body.view-editor #previewPane { display: none; }
  body.view-preview #editorPane { display: none; }

  /* Barra de status */
  #statusbar {
    display: flex; align-items: center; gap: 16px; padding: 5px 16px; font-size: 12px;
    color: var(--muted); background: var(--surface); border-top: 1px solid var(--border);
  }
  #statusbar .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa0a6; display: inline-block; margin-right: 5px; }
  #statusbar .dot.ok { background: var(--green); }
  #statusbar .dot.err { background: var(--danger); }

  /* ── Diálogos ───────────────────────────────────────────────────────── */
  dialog {
    border: 0; border-radius: 12px; padding: 0; min-width: 460px; max-width: 620px;
    box-shadow: 0 8px 30px rgba(0,0,0,.25); color: var(--text);
  }
  dialog::backdrop { background: rgba(32,33,36,.5); }
  dialog .dlg-head { padding: 18px 22px 0; font-size: 17px; font-weight: 600; }
  dialog .dlg-body { padding: 14px 22px; }
  dialog .dlg-foot { padding: 12px 22px 18px; display: flex; justify-content: flex-end; gap: 8px; }
  dialog label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin: 12px 0 4px; }
  dialog input[type=text], dialog select, dialog textarea {
    width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px;
    font-size: 13px; font-family: inherit; background: var(--surface); color: var(--text);
  }
  dialog textarea { font-family: ui-monospace, monospace; min-height: 220px; resize: vertical; }
  dialog input:focus, dialog select:focus, dialog textarea:focus { outline: 2px solid var(--primary); border-color: transparent; }
  dialog .error { color: var(--danger); font-size: 12px; margin-top: 8px; min-height: 16px; }
  dialog .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; margin-top: 6px; max-height: 180px; overflow: auto; }
  dialog .checks label { display: flex; align-items: center; gap: 8px; font-weight: 400; font-size: 13px; color: var(--text); margin: 0; }
  dialog .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  dialog .inline-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); font-weight: 400; margin-top: 12px; }

  /* Toast */
  #toast {
    position: fixed; left: 50%; bottom: 46px; transform: translateX(-50%) translateY(20px);
    background: #323232; color: #fff; padding: 10px 20px; border-radius: 8px; font-size: 13px;
    opacity: 0; pointer-events: none; transition: all .25s ease; z-index: 100; max-width: 70vw;
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #toast.err { background: var(--danger); }
</style>
</head>
<body class="view-split">

<div id="appbar">
  <div id="logo">📄</div>
  <input id="docName" value="Relatório sem título" spellcheck="false" title="Nome do template" />
  <span class="spacer"></span>
  <button class="btn" id="btnPasteJson">📋 Colar JSON</button>
  <button class="btn" id="btnConnect">🔌 Conectar ao sistema</button>
  <button class="btn primary" id="btnExport">⬆ Exportar template</button>
</div>

<div id="toolbar">
  <div class="menu-wrap">
    <button class="tb" id="mStylesBtn" title="Estilos de texto">Estilos ▾</button>
    <div class="menu" id="mStyles">
      <button class="mi" data-wrap="<h1 style='margin:4px 0'>|</h1>" style="font-size:20px;font-weight:700">Título 1</button>
      <button class="mi" data-wrap="<h2 style='margin:4px 0'>|</h2>" style="font-size:17px;font-weight:600">Título 2</button>
      <button class="mi" data-wrap="<h3 style='margin:4px 0'>|</h3>" style="font-size:15px;font-weight:600">Título 3</button>
      <button class="mi" data-wrap="<p>|</p>">Parágrafo</button>
      <button class="mi" data-wrap="<small>|</small>" style="font-size:11px">Texto pequeno</button>
    </div>
  </div>
  <span class="tb-sep"></span>
  <button class="tb" data-wrap="<b>|</b>" title="Negrito"><b>N</b></button>
  <button class="tb" data-wrap="<i>|</i>" title="Itálico"><i>I</i></button>
  <button class="tb" data-wrap="<u>|</u>" title="Sublinhado"><u>S</u></button>
  <span class="tb-sep"></span>
  <button class="tb" data-wrap="<div style='text-align:left'>|</div>" title="Alinhar à esquerda">⇤</button>
  <button class="tb" data-wrap="<div style='text-align:center'>|</div>" title="Centralizar">≡</button>
  <button class="tb" data-wrap="<div style='text-align:right'>|</div>" title="Alinhar à direita">⇥</button>
  <span class="tb-sep"></span>
  <button class="tb" data-insert="<hr />" title="Linha horizontal">─</button>
  <button class="tb" data-insert="<div style='page-break-after: always'></div>" title="Quebra de página">⤓ Pág.</button>
  <button class="tb" data-insert="{{> assinaturas}}" title="Bloco de assinaturas">✍ Assin.</button>
  <span class="tb-sep"></span>
  <button class="tb wizard" id="btnWizTable" title="Monta uma tabela a partir de uma lista dos dados">▦ Tabela</button>
  <button class="tb wizard" id="btnWizCond" title="Mostra um trecho apenas quando a condição vale">⑂ Condicional</button>
  <button class="tb wizard" id="btnWizCalc" title="Soma, média, contagem… de uma lista">Σ Cálculo</button>
  <div class="menu-wrap">
    <button class="tb wizard" id="mHelpersBtn" title="Todas as funções disponíveis">ƒ Funções ▾</button>
    <div class="menu" id="mHelpers"></div>
  </div>
  <div id="viewToggle">
    <button class="tb" data-view="view-editor" title="Somente editor">Código</button>
    <button class="tb active" data-view="view-split" title="Editor + preview">Dividido</button>
    <button class="tb" data-view="view-preview" title="Somente preview">Visualizar</button>
  </div>
</div>

<main>
  <aside id="sidebar">
    <header>
      <span>Campos dos dados</span>
      <button class="btn" id="btnPasteJson2">Colar JSON</button>
    </header>
    <div id="dataTree"><div class="hint">Nenhum dado carregado ainda.<br /><br />Use <b>Colar JSON</b> (cole os dados do relatório) ou <b>Conectar ao sistema</b> para buscar os dados reais.<br /><br />Depois é só <b>arrastar um campo</b> até o editor — ou clicar no <b>+</b> — que o Studio escreve o código para você.</div></div>
    <div id="dragTip">💡 Arraste um campo para o texto do relatório. Listas (▦) viram tabelas ou repetições.</div>
  </aside>

  <section id="editorPane">
    <div class="pane-title">Modelo (Handlebars)</div>
    <div id="editorWrap">
      <pre id="editorHl" aria-hidden="true"><code id="editorCode"></code></pre>
      <textarea id="editor" spellcheck="false" placeholder="Escreva o modelo do relatório aqui…"></textarea>
    </div>
  </section>

  <section id="previewPane">
    <div class="pane-title">
      Pré-visualização
      <select id="zoom">
        <option value="0.75">75%</option>
        <option value="1" selected>100%</option>
        <option value="1.25">125%</option>
      </select>
    </div>
    <div id="renderError"></div>
    <div id="paperScroll">
      <div id="paper">
        <iframe id="preview" sandbox="allow-scripts allow-same-origin" title="Pré-visualização do relatório"></iframe>
      </div>
    </div>
  </section>
</main>

<div id="statusbar">
  <span><span class="dot" id="statusDot"></span><span id="status">pronto</span></span>
  <span id="dataInfo">sem dados carregados</span>
  <span class="spacer" style="flex:1"></span>
  <span>💾 salvo automaticamente neste navegador</span>
</div>

<div id="toast"></div>

<!-- ── Colar JSON ──────────────────────────────────────────────────────── -->
<dialog id="dlgJson">
  <div class="dlg-head">Colar dados (JSON)</div>
  <div class="dlg-body">
    <p style="margin:4px 0;color:var(--muted);font-size:13px">Cole abaixo o JSON com os dados do relatório. Os campos aparecem no painel à esquerda para arrastar.</p>
    <textarea id="jsonInput" placeholder='{"titulo": "Meu relatório", "itens": [{"nome": "Item A", "valor": 10}]}'></textarea>
    <div class="error" id="jsonError"></div>
  </div>
  <div class="dlg-foot">
    <button class="btn" data-close="dlgJson">Cancelar</button>
    <button class="btn primary" id="btnJsonOk">Usar estes dados</button>
  </div>
</dialog>

<!-- ── Conectar ao sistema ─────────────────────────────────────────────── -->
<dialog id="dlgConnect">
  <div class="dlg-head">Conectar ao sistema</div>
  <div class="dlg-body">
    <label>URL de dados (POST …/relatorio/api/data/&lt;reportId&gt;)</label>
    <input type="text" id="dataUrl" placeholder="http://host/relatorio/api/data/meu-relatorio" />
    <label>Headers (JSON)</label>
    <input type="text" id="headersJson" placeholder='{"authorization":"Bearer …","entidade":"4"}' />
    <label>Filtros (JSON enviado no corpo)</label>
    <input type="text" id="filtersJson" value="{}" />
    <div class="error" id="connectError"></div>
  </div>
  <div class="dlg-foot">
    <button class="btn" data-close="dlgConnect">Cancelar</button>
    <button class="btn primary" id="btnLoad">Carregar dados</button>
  </div>
</dialog>

<!-- ── Assistente: tabela ──────────────────────────────────────────────── -->
<dialog id="dlgTable">
  <div class="dlg-head">Inserir tabela</div>
  <div class="dlg-body">
    <label>Qual lista dos dados?</label>
    <select id="tableArray"></select>
    <label>Colunas (marque as que devem aparecer)</label>
    <div class="checks" id="tableCols"></div>
    <label class="inline-check"><input type="checkbox" id="tableTotals" /> Incluir linha de <b>total</b> (soma das colunas numéricas)</label>
    <label class="inline-check"><input type="checkbox" id="tableIndex" checked /> Incluir coluna <b>#</b> (número da linha)</label>
    <div class="error" id="tableError"></div>
  </div>
  <div class="dlg-foot">
    <button class="btn" data-close="dlgTable">Cancelar</button>
    <button class="btn primary" id="btnTableOk">Inserir tabela</button>
  </div>
</dialog>

<!-- ── Assistente: condicional ─────────────────────────────────────────── -->
<dialog id="dlgCond">
  <div class="dlg-head">Inserir condicional (mostrar apenas se…)</div>
  <div class="dlg-body">
    <label>Campo</label>
    <input type="text" id="condField" list="allPaths" placeholder="ex.: status ou this.valor (dentro de tabela)" />
    <datalist id="allPaths"></datalist>
    <div class="row2">
      <div>
        <label>Condição</label>
        <select id="condOp">
          <option value="==">é igual a</option>
          <option value="!=">é diferente de</option>
          <option value=">">é maior que</option>
          <option value=">=">é maior ou igual a</option>
          <option value="<">é menor que</option>
          <option value="<=">é menor ou igual a</option>
          <option value="contem">contém o texto</option>
          <option value="preenchido">está preenchido</option>
          <option value="vazio">está vazio</option>
        </select>
      </div>
      <div>
        <label>Valor</label>
        <input type="text" id="condValue" placeholder="ex.: ATIVO ou 100" />
      </div>
    </div>
    <label class="inline-check"><input type="checkbox" id="condElse" /> Incluir "senão" (conteúdo alternativo)</label>
    <div class="error" id="condError"></div>
  </div>
  <div class="dlg-foot">
    <button class="btn" data-close="dlgCond">Cancelar</button>
    <button class="btn primary" id="btnCondOk">Inserir condicional</button>
  </div>
</dialog>

<!-- ── Assistente: cálculo ─────────────────────────────────────────────── -->
<dialog id="dlgCalc">
  <div class="dlg-head">Inserir cálculo</div>
  <div class="dlg-body">
    <div class="row2">
      <div>
        <label>Operação</label>
        <select id="calcOp">
          <option value="sum">Soma</option>
          <option value="avg">Média</option>
          <option value="min">Menor valor</option>
          <option value="max">Maior valor</option>
          <option value="count">Contagem de itens</option>
        </select>
      </div>
      <div>
        <label>Lista</label>
        <select id="calcArray"></select>
      </div>
    </div>
    <label>Campo numérico</label>
    <select id="calcField"></select>
    <label class="inline-check"><input type="checkbox" id="calcCurrency" checked /> Formatar como moeda (R$)</label>
    <div class="error" id="calcError"></div>
  </div>
  <div class="dlg-foot">
    <button class="btn" data-close="dlgCalc">Cancelar</button>
    <button class="btn primary" id="btnCalcOk">Inserir cálculo</button>
  </div>
</dialog>

<!-- ── Exportar ────────────────────────────────────────────────────────── -->
<dialog id="dlgExport">
  <div class="dlg-head">Exportar template para o sistema</div>
  <div class="dlg-body">
    <label>URL de templates (POST …/templates/&lt;reportId&gt;)</label>
    <input type="text" id="exportUrl" placeholder="http://host/relatorio/api/templates/meu-relatorio" />
    <label>Nome do template</label>
    <input type="text" id="exportName" placeholder="Modelo personalizado" />
    <div class="error" id="exportError"></div>
  </div>
  <div class="dlg-foot">
    <button class="btn" data-close="dlgExport">Cancelar</button>
    <button class="btn primary" id="btnDoExport">Exportar</button>
  </div>
</dialog>

<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var editor = $("editor");
  var reportData = {};

  var STARTER_TEMPLATE = [
    '<div style="font-family: Arial, sans-serif; padding: 24px; font-size: 13px;">',
    '  <h1 style="margin:4px 0">{{titulo}}</h1>',
    '  <p><small>Gerado em {{dateNow}}</small></p>',
    '  <hr />',
    '  <p>Use o painel da esquerda para carregar seus dados e arraste os campos até aqui.</p>',
    '</div>'
  ].join("\\n");

  var SAMPLE_DATA = {
    titulo: "Relatório de exemplo",
    responsavel: "Setor de Qualidade",
    itens: [
      {nome: "Item A", categoria: "Insumo", valor: 150.5, quantidade: 3},
      {nome: "Item B", categoria: "Serviço", valor: 89.9, quantidade: 1},
      {nome: "Item C", categoria: "Insumo", valor: 42, quantidade: 7}
    ]
  };

  // ── Persistência local (não perder o trabalho ao fechar) ───────────────
  function saveLocal() {
    try {
      localStorage.setItem("studio.template", editor.value);
      localStorage.setItem("studio.data", JSON.stringify(reportData));
      localStorage.setItem("studio.docName", $("docName").value);
      localStorage.setItem("studio.dataUrl", $("dataUrl").value);
      localStorage.setItem("studio.headersJson", $("headersJson").value);
      localStorage.setItem("studio.filtersJson", $("filtersJson").value);
      localStorage.setItem("studio.exportUrl", $("exportUrl").value);
    } catch (e) { /* armazenamento cheio/bloqueado não pode travar o editor */ }
  }
  function restoreLocal() {
    editor.value = localStorage.getItem("studio.template") || STARTER_TEMPLATE;
    $("docName").value = localStorage.getItem("studio.docName") || "Relatório sem título";
    $("dataUrl").value = localStorage.getItem("studio.dataUrl") || "";
    $("headersJson").value = localStorage.getItem("studio.headersJson") || "";
    $("filtersJson").value = localStorage.getItem("studio.filtersJson") || "{}";
    $("exportUrl").value = localStorage.getItem("studio.exportUrl") || "";
    try { reportData = JSON.parse(localStorage.getItem("studio.data") || "null") || SAMPLE_DATA; }
    catch (e) { reportData = SAMPLE_DATA; }
  }

  // ── Status/toast ───────────────────────────────────────────────────────
  var toastTimer;
  function toast(msg, isError) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "show" + (isError ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ""; }, 3200);
  }
  function status(msg, state) {
    $("status").textContent = msg;
    $("statusDot").className = "dot" + (state === "ok" ? " ok" : state === "err" ? " err" : "");
  }

  // ── Syntax highlight (overlay: <pre> colorido atrás do textarea) ───────
  var editorCode = $("editorCode");
  var editorHl = $("editorHl");
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // Percorre src com a regex e escapa o texto entre os matches.
  function paint(src, re, renderMatch) {
    var out = "", last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      out += renderMatch(m);
      last = m.index + m[0].length;
      if (!m[0].length) re.lastIndex++;
    }
    return out + esc(src.slice(last));
  }
  var RE_HBS = /\\{\\{[^]*?\\}\\}/g;
  var RE_MASTER = /(\\{\\{[^]*?\\}\\})|(<!--[^]*?-->)|(<\\/?[a-zA-Z][^<>]*>?)/g;
  var RE_TAG_PARTS = /^(<\\/?)([a-zA-Z][-a-zA-Z0-9]*)([^]*)$/;
  var RE_TAG_BODY = /(\\{\\{[^]*?\\}\\})|("[^"]*"?|'[^']*'?)|([a-zA-Z_][-a-zA-Z0-9_:.]*)(?=\\s*=)/g;
  function hbsSpan(code) {
    var isBlock = code.charAt(2) === "#" || code.charAt(2) === "/" || code.indexOf("{{else") === 0;
    return '<span class="' + (isBlock ? "tok-hbs-block" : "tok-hbs") + '">' + esc(code) + "</span>";
  }
  function tagBodyToken(m) {
    if (m[1]) return hbsSpan(m[1]);
    if (m[2]) {
      // Strings de atributo podem conter {{campo}} — realça por dentro.
      return '<span class="tok-str">' + paint(m[2], RE_HBS, function (s) { return hbsSpan(s[0]); }) + "</span>";
    }
    return '<span class="tok-attr">' + esc(m[3]) + "</span>";
  }
  function tagSpan(tag) {
    var parts = tag.match(RE_TAG_PARTS);
    if (!parts) return esc(tag);
    return '<span class="tok-pun">' + esc(parts[1]) + "</span>" +
      '<span class="tok-tag">' + esc(parts[2]) + "</span>" +
      paint(parts[3], RE_TAG_BODY, tagBodyToken);
  }
  function masterToken(m) {
    if (m[1]) return hbsSpan(m[1]);
    if (m[2]) return '<span class="tok-com">' + esc(m[2]) + "</span>";
    return tagSpan(m[3]);
  }
  function refreshHighlight() {
    // \\n final: mantém a altura do <pre> igual à do textarea na última linha.
    editorCode.innerHTML = paint(editor.value, RE_MASTER, masterToken) + "\\n";
  }
  editor.addEventListener("scroll", function () {
    editorHl.scrollTop = editor.scrollTop;
    editorHl.scrollLeft = editor.scrollLeft;
  });

  // ── Inserção no editor ─────────────────────────────────────────────────
  function insertAtCaret(text) {
    var start = editor.selectionStart, end = editor.selectionEnd;
    editor.setRangeText(text, start, end, "end");
    editor.focus();
    onEdited();
  }
  function wrapSelection(pattern) {
    var start = editor.selectionStart, end = editor.selectionEnd;
    var selected = editor.value.slice(start, end);
    var parts = pattern.split("|");
    var replacement = parts[0] + selected + (parts[1] || "");
    editor.setRangeText(replacement, start, end, "end");
    if (!selected) {
      var caret = start + parts[0].length;
      editor.setSelectionRange(caret, caret);
    }
    editor.focus();
    onEdited();
  }

  // ── Render (preview) ───────────────────────────────────────────────────
  var renderTimer;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 350);
  }
  // Toda edição passa por aqui: realce imediato, preview com debounce, autosave.
  function onEdited() {
    refreshHighlight();
    scheduleRender();
    saveLocal();
  }
  function render() {
    status("renderizando…");
    fetch("/api/render", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({template: editor.value, data: reportData})
    }).then(function (res) {
      return res.json().then(function (body) { return {ok: res.ok, body: body}; });
    }).then(function (r) {
      var errBox = $("renderError");
      if (!r.ok) {
        errBox.textContent = "Erro no modelo: " + (r.body.message || "desconhecido");
        errBox.classList.add("show");
        status("erro no modelo", "err");
        return;
      }
      errBox.classList.remove("show");
      $("preview").srcdoc = r.body.html;
      status("preview atualizado", "ok");
    }).catch(function (err) {
      status("falha ao renderizar: " + err.message, "err");
    });
  }

  editor.addEventListener("input", onEdited);
  // Realce visual durante o arraste; o próprio navegador insere o texto no drop.
  editor.addEventListener("dragover", function () { $("editorWrap").classList.add("dropping"); });
  editor.addEventListener("dragleave", function () { $("editorWrap").classList.remove("dropping"); });
  editor.addEventListener("drop", function () {
    $("editorWrap").classList.remove("dropping");
    setTimeout(onEdited, 0);
  });

  // ── Árvore de dados ────────────────────────────────────────────────────
  var arraysInfo = []; // {path, label, fields:[{name, numeric}]}
  var scalarPaths = [];

  function typeLabel(value) {
    if (Array.isArray(value)) return {text: "lista", cls: "arr"};
    if (value === null) return {text: "vazio", cls: ""};
    if (typeof value === "number") return {text: "número", cls: "num"};
    if (typeof value === "boolean") return {text: "sim/não", cls: ""};
    if (typeof value === "object") return {text: "grupo", cls: ""};
    return {text: "texto", cls: ""};
  }
  function sampleText(value) {
    if (value == null) return "";
    if (Array.isArray(value)) return value.length + " item(ns)";
    if (typeof value === "object") return "";
    var s = String(value);
    return s.length > 28 ? s.slice(0, 28) + "…" : s;
  }
  function eachSnippet(path) {
    return "{{#each " + path + "}}\\n  \\n{{/each}}";
  }
  function itemFields(array) {
    var first = null;
    for (var i = 0; i < array.length; i++) {
      if (array[i] && typeof array[i] === "object" && !Array.isArray(array[i])) { first = array[i]; break; }
    }
    if (!first) return [];
    return Object.keys(first).map(function (key) {
      return {name: key, numeric: typeof first[key] === "number"};
    });
  }

  function makeRow(key, value, dragText, depth) {
    var row = document.createElement("div");
    row.className = "node-row";
    row.draggable = true;
    row.title = "Arraste para o editor ou clique no + para inserir: " + dragText;
    row.addEventListener("dragstart", function (e) {
      e.dataTransfer.setData("text/plain", dragText);
      e.dataTransfer.effectAllowed = "copy";
    });
    var type = typeLabel(value);
    var keyEl = document.createElement("span");
    keyEl.className = "key";
    keyEl.textContent = (Array.isArray(value) ? "▦ " : "") + key;
    var typeEl = document.createElement("span");
    typeEl.className = "type " + type.cls;
    typeEl.textContent = type.text;
    var sampleEl = document.createElement("span");
    sampleEl.className = "sample";
    sampleEl.textContent = sampleText(value);
    var addBtn = document.createElement("button");
    addBtn.className = "node-add";
    addBtn.textContent = "+";
    addBtn.title = "Inserir no editor";
    addBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      insertAtCaret(dragText);
      toast("Inserido: " + dragText.split("\\n")[0]);
    });
    row.appendChild(keyEl);
    row.appendChild(typeEl);
    row.appendChild(sampleEl);
    row.appendChild(addBtn);
    return row;
  }

  function buildNode(key, value, path, insideArray) {
    var node = document.createElement("div");
    node.className = "node";
    var mustache = insideArray ? "{{this." + path + "}}" : "{{" + path + "}}";
    var dragText = Array.isArray(value) ? eachSnippet(insideArray ? "this." + path : path) : mustache;
    var row = makeRow(key, value, dragText, 0);
    node.appendChild(row);

    var children = null;
    if (Array.isArray(value)) {
      arraysInfo.push({path: insideArray ? "this." + path : path, label: key, fields: itemFields(value)});
      var first = value.find(function (v) { return v && typeof v === "object" && !Array.isArray(v); });
      if (first) {
        children = document.createElement("div");
        children.className = "node-children";
        Object.keys(first).forEach(function (childKey) {
          children.appendChild(buildNode(childKey, first[childKey], childKey, true));
        });
      }
    }
    if (!Array.isArray(value) && value && typeof value === "object") {
      children = document.createElement("div");
      children.className = "node-children";
      Object.keys(value).forEach(function (childKey) {
        var childPath = path + "." + childKey;
        children.appendChild(buildNode(childKey, value[childKey], insideArray ? childPath : childPath, insideArray));
      });
    }
    if (!Array.isArray(value) && (!value || typeof value !== "object")) {
      scalarPaths.push(insideArray ? "this." + path : path);
    }
    if (children) node.appendChild(children);
    return node;
  }

  function rebuildTree() {
    arraysInfo = [];
    scalarPaths = [];
    var tree = $("dataTree");
    tree.innerHTML = "";
    var keys = Object.keys(reportData || {});
    if (!keys.length) {
      tree.innerHTML = '<div class="hint">O JSON está vazio. Cole um JSON com dados para ver os campos aqui.</div>';
      $("dataInfo").textContent = "sem dados carregados";
      return;
    }
    keys.forEach(function (key) {
      tree.appendChild(buildNode(key, reportData[key], key, false));
    });
    $("dataInfo").textContent = "dados: " + keys.length + " campo(s) de topo · " + arraysInfo.length + " lista(s)";
    var datalist = $("allPaths");
    datalist.innerHTML = "";
    scalarPaths.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p;
      datalist.appendChild(opt);
    });
  }

  function setData(data, sourceLabel) {
    reportData = data || {};
    rebuildTree();
    saveLocal();
    render();
    if (sourceLabel) toast("Dados carregados (" + sourceLabel + ") ✔");
  }

  // ── Diálogos genéricos ─────────────────────────────────────────────────
  document.querySelectorAll("[data-close]").forEach(function (btn) {
    btn.addEventListener("click", function () { $(btn.getAttribute("data-close")).close(); });
  });
  function openDialog(id) { $(id).showModal(); }

  // ── Colar JSON ─────────────────────────────────────────────────────────
  function openJsonDialog() {
    $("jsonError").textContent = "";
    $("jsonInput").value = Object.keys(reportData || {}).length
      ? JSON.stringify(reportData, null, 2) : "";
    openDialog("dlgJson");
  }
  $("btnPasteJson").addEventListener("click", openJsonDialog);
  $("btnPasteJson2").addEventListener("click", openJsonDialog);
  $("btnJsonOk").addEventListener("click", function () {
    try {
      var parsed = JSON.parse($("jsonInput").value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        $("jsonError").textContent = "O JSON precisa ser um objeto no topo, ex.: {\\"itens\\": [...]}";
        return;
      }
      $("dlgJson").close();
      setData(parsed, "JSON colado");
    } catch (e) {
      $("jsonError").textContent = "JSON inválido: " + e.message;
    }
  });

  // ── Conectar ao sistema ────────────────────────────────────────────────
  $("btnConnect").addEventListener("click", function () {
    $("connectError").textContent = "";
    openDialog("dlgConnect");
  });
  function parseJsonField(id, fallback) {
    var raw = $(id).value.trim();
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  $("btnLoad").addEventListener("click", function () {
    var headers = parseJsonField("headersJson", {});
    var filters = parseJsonField("filtersJson", {});
    if (headers === null || filters === null) {
      $("connectError").textContent = "Headers/Filtros precisam ser JSON válido.";
      return;
    }
    $("connectError").textContent = "";
    status("carregando dados do sistema…");
    fetch("/api/fetch-data", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({url: $("dataUrl").value.trim(), headers: headers, filters: filters})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return {ok: res.ok, status: res.status, body: body}; });
    }).then(function (r) {
      if (!r.ok) {
        $("connectError").textContent = "Erro " + r.status + ": " + (r.body.message || "falha ao buscar dados");
        status("erro ao carregar dados", "err");
        return;
      }
      $("dlgConnect").close();
      saveLocal();
      setData(r.body, "sistema");
    }).catch(function (err) {
      $("connectError").textContent = "Falha de rede: " + err.message;
    });
  });

  // ── Toolbar: wrap/insert ───────────────────────────────────────────────
  document.querySelectorAll("[data-wrap]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      wrapSelection(btn.getAttribute("data-wrap"));
      closeMenus();
    });
  });
  document.querySelectorAll("[data-insert]").forEach(function (btn) {
    btn.addEventListener("click", function () { insertAtCaret(btn.getAttribute("data-insert")); });
  });

  // Menus suspensos
  function closeMenus() {
    document.querySelectorAll(".menu.open").forEach(function (m) { m.classList.remove("open"); });
  }
  function bindMenu(btnId, menuId) {
    $(btnId).addEventListener("click", function (e) {
      e.stopPropagation();
      var menu = $(menuId);
      var wasOpen = menu.classList.contains("open");
      closeMenus();
      if (!wasOpen) menu.classList.add("open");
    });
  }
  bindMenu("mStylesBtn", "mStyles");
  bindMenu("mHelpersBtn", "mHelpers");
  document.addEventListener("click", closeMenus);

  // Menu de funções (catálogo vem do servidor — mesma fonte do worker de PDF)
  var CATEGORY_TITLES = {formato: "Formatação", calculo: "Cálculo", logica: "Lógica"};
  fetch("/api/helpers").then(function (res) { return res.json(); }).then(function (helpers) {
    var menu = $("mHelpers");
    var lastCategory = "";
    helpers.forEach(function (helper) {
      if (helper.category !== lastCategory) {
        lastCategory = helper.category;
        var h = document.createElement("h5");
        h.textContent = CATEGORY_TITLES[helper.category] || helper.category;
        menu.appendChild(h);
      }
      var btn = document.createElement("button");
      btn.className = "mi";
      btn.innerHTML = "<b>" + helper.name + "</b> <small>" + helper.description + "</small><code></code>";
      btn.querySelector("code").textContent = helper.snippet;
      btn.addEventListener("click", function () {
        insertAtCaret(helper.snippet);
        closeMenus();
      });
      menu.appendChild(btn);
    });
  }).catch(function () { /* menu de funções é opcional; o editor segue funcionando */ });

  // ── Alternância de visão ───────────────────────────────────────────────
  document.querySelectorAll("#viewToggle .tb").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.body.className = btn.getAttribute("data-view");
      document.querySelectorAll("#viewToggle .tb").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
    });
  });

  // ── Zoom do preview ────────────────────────────────────────────────────
  $("zoom").addEventListener("change", function () {
    $("paper").style.transform = "scale(" + $("zoom").value + ")";
  });

  // ── Assistente: tabela ─────────────────────────────────────────────────
  function fillArraySelect(selectId) {
    var select = $(selectId);
    select.innerHTML = "";
    arraysInfo.forEach(function (info) {
      var opt = document.createElement("option");
      opt.value = info.path;
      opt.textContent = info.label + " (" + info.path + ")";
      select.appendChild(opt);
    });
    return arraysInfo.length > 0;
  }
  function arrayByPath(path) {
    return arraysInfo.find(function (info) { return info.path === path; });
  }

  $("btnWizTable").addEventListener("click", function () {
    if (!fillArraySelect("tableArray")) {
      toast("Carregue dados com pelo menos uma lista para montar tabelas.", true);
      return;
    }
    renderTableCols();
    $("tableError").textContent = "";
    openDialog("dlgTable");
  });
  $("tableArray").addEventListener("change", renderTableCols);
  function renderTableCols() {
    var info = arrayByPath($("tableArray").value);
    var box = $("tableCols");
    box.innerHTML = "";
    (info ? info.fields : []).forEach(function (field) {
      var label = document.createElement("label");
      var check = document.createElement("input");
      check.type = "checkbox";
      check.checked = true;
      check.value = field.name;
      check.dataset.numeric = field.numeric ? "1" : "";
      label.appendChild(check);
      label.appendChild(document.createTextNode(field.name + (field.numeric ? " (número)" : "")));
      box.appendChild(label);
    });
  }
  $("btnTableOk").addEventListener("click", function () {
    var info = arrayByPath($("tableArray").value);
    var checks = Array.prototype.slice.call($("tableCols").querySelectorAll("input:checked"));
    if (!info || !checks.length) {
      $("tableError").textContent = "Escolha ao menos uma coluna.";
      return;
    }
    var withIndex = $("tableIndex").checked;
    var withTotals = $("tableTotals").checked;
    var cols = checks.map(function (c) { return {name: c.value, numeric: c.dataset.numeric === "1"}; });
    var th = 'border:1px solid #ccc; padding:6px 8px; background:#f0f0f0; text-align:left;';
    var td = 'border:1px solid #ccc; padding:6px 8px;';
    var lines = [];
    lines.push('<table style="width:100%; border-collapse:collapse; font-size:12px;">');
    lines.push('  <thead>');
    lines.push('    <tr>');
    if (withIndex) lines.push('      <th style="' + th + ' width:36px">#</th>');
    cols.forEach(function (col) {
      lines.push('      <th style="' + th + (col.numeric ? ' text-align:right;' : '') + '">' + col.name + '</th>');
    });
    lines.push('    </tr>');
    lines.push('  </thead>');
    lines.push('  <tbody>');
    lines.push('    {{#each ' + info.path + '}}');
    lines.push('    <tr>');
    if (withIndex) lines.push('      <td style="' + td + '">{{index1 @index}}</td>');
    cols.forEach(function (col) {
      var cell = col.numeric ? "{{number this." + col.name + "}}" : "{{this." + col.name + "}}";
      lines.push('      <td style="' + td + (col.numeric ? ' text-align:right;' : '') + '">' + cell + '</td>');
    });
    lines.push('    </tr>');
    lines.push('    {{/each}}');
    if (withTotals) {
      lines.push('    <tr>');
      if (withIndex) lines.push('      <td style="' + td + ' font-weight:bold">Total</td>');
      cols.forEach(function (col, i) {
        var isFirstLabelCell = !withIndex && i === 0;
        if (col.numeric) {
          lines.push('      <td style="' + td + ' text-align:right; font-weight:bold">{{number (sum ' + info.path + ' "' + col.name + '")}}</td>');
        } else {
          lines.push('      <td style="' + td + ' font-weight:bold">' + (isFirstLabelCell ? "Total" : "") + '</td>');
        }
      });
      lines.push('    </tr>');
    }
    lines.push('  </tbody>');
    lines.push('</table>');
    $("dlgTable").close();
    insertAtCaret("\\n" + lines.join("\\n") + "\\n");
    toast("Tabela inserida ✔");
  });

  // ── Assistente: condicional ────────────────────────────────────────────
  var NO_VALUE_OPS = {vazio: true, preenchido: true};
  $("btnWizCond").addEventListener("click", function () {
    $("condError").textContent = "";
    openDialog("dlgCond");
  });
  $("condOp").addEventListener("change", function () {
    $("condValue").disabled = !!NO_VALUE_OPS[$("condOp").value];
  });
  $("btnCondOk").addEventListener("click", function () {
    var field = $("condField").value.trim();
    var op = $("condOp").value;
    var rawValue = $("condValue").value.trim();
    if (!field) { $("condError").textContent = "Informe o campo."; return; }
    if (!NO_VALUE_OPS[op] && !rawValue) { $("condError").textContent = "Informe o valor da comparação."; return; }
    var value = "";
    if (!NO_VALUE_OPS[op]) {
      var isNumber = rawValue !== "" && !isNaN(Number(rawValue));
      var isBool = rawValue === "true" || rawValue === "false";
      value = " " + (isNumber || isBool ? rawValue : '"' + rawValue.replace(/"/g, '\\\\"') + '"');
    }
    var block = '{{#ifCond ' + field + ' "' + op + '"' + value + '}}\\n  \\n';
    if ($("condElse").checked) block += '{{else}}\\n  \\n';
    block += '{{/ifCond}}';
    $("dlgCond").close();
    insertAtCaret("\\n" + block + "\\n");
    toast("Condicional inserida ✔ Escreva o conteúdo dentro dela.");
  });

  // ── Assistente: cálculo ────────────────────────────────────────────────
  $("btnWizCalc").addEventListener("click", function () {
    if (!fillArraySelect("calcArray")) {
      toast("Carregue dados com pelo menos uma lista para calcular.", true);
      return;
    }
    renderCalcFields();
    $("calcError").textContent = "";
    openDialog("dlgCalc");
  });
  $("calcArray").addEventListener("change", renderCalcFields);
  $("calcOp").addEventListener("change", renderCalcFields);
  function renderCalcFields() {
    var info = arrayByPath($("calcArray").value);
    var select = $("calcField");
    var isCount = $("calcOp").value === "count";
    select.innerHTML = "";
    select.disabled = isCount;
    $("calcCurrency").disabled = isCount;
    if (isCount) return;
    (info ? info.fields : []).filter(function (f) { return f.numeric; }).forEach(function (field) {
      var opt = document.createElement("option");
      opt.value = field.name;
      opt.textContent = field.name;
      select.appendChild(opt);
    });
  }
  $("btnCalcOk").addEventListener("click", function () {
    var info = arrayByPath($("calcArray").value);
    var op = $("calcOp").value;
    if (!info) { $("calcError").textContent = "Escolha uma lista."; return; }
    var snippet;
    if (op === "count") {
      snippet = "{{count " + info.path + "}}";
    } else {
      var field = $("calcField").value;
      if (!field) { $("calcError").textContent = "A lista escolhida não tem campos numéricos."; return; }
      var inner = "(" + op + " " + info.path + ' "' + field + '")';
      snippet = $("calcCurrency").checked ? "{{currency " + inner + "}}" : "{{number " + inner + "}}";
    }
    $("dlgCalc").close();
    insertAtCaret(snippet);
    toast("Cálculo inserido: " + snippet);
  });

  // ── Exportar ───────────────────────────────────────────────────────────
  $("btnExport").addEventListener("click", function () {
    $("exportError").textContent = "";
    if (!$("exportName").value.trim()) $("exportName").value = $("docName").value;
    openDialog("dlgExport");
  });
  $("btnDoExport").addEventListener("click", function () {
    var headers = parseJsonField("headersJson", {});
    status("exportando…");
    fetch("/api/export", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        url: $("exportUrl").value.trim(),
        headers: headers || {},
        name: $("exportName").value.trim() || "Modelo do Studio",
        content: editor.value
      })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return {ok: res.ok, status: res.status, body: body}; });
    }).then(function (r) {
      if (!r.ok) {
        $("exportError").textContent = "Erro " + r.status + ": " + (r.body.message || "falha ao exportar");
        status("erro ao exportar", "err");
        return;
      }
      $("dlgExport").close();
      saveLocal();
      status("template exportado", "ok");
      toast("Template exportado para o sistema ✔");
    }).catch(function (err) {
      $("exportError").textContent = "Falha de rede: " + err.message;
    });
  });

  $("docName").addEventListener("input", saveLocal);

  // ── Boot ───────────────────────────────────────────────────────────────
  restoreLocal();
  refreshHighlight();
  rebuildTree();
  render();
})();
</script>
</body>
</html>`;
}

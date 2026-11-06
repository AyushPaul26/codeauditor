const attribute = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function panelHtml(
  nonce: string,
  cssUri: string,
  jsUri: string,
  cspSource: string,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${attribute(cspSource)}; script-src 'nonce-${attribute(nonce)}';"><link rel="stylesheet" href="${attribute(cssUri)}"><title>CodeAuditor</title></head><body>
  <header><div class="brand"><span class="brand-mark" aria-hidden="true">&lt;/&gt;</span><div><strong>CodeAuditor</strong><span class="caption">Local coding agent</span></div></div><button id="connection" class="quiet" type="button">Check connection</button></header>
  <div id="status" class="status" role="status" aria-live="polite"><span class="status-dot" aria-hidden="true"></span><span id="status-text">Ready to connect</span></div>
  <main><section id="welcome"><h1>Understand first.<br>Change with confidence.</h1><p>Describe a change. Review each hunk before it reaches your code.</p><div class="hint"><span aria-hidden="true">↗</span><p>Select code and press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>E</kbd> to edit a region.</p></div></section>
  <section id="context-section" hidden><h2>Selected context <span id="context-count" class="count"></span></h2><p id="context-budget" class="caption"></p><ul id="context-list"></ul></section>
  <section id="activity-section" hidden><h2>Agent activity</h2><ol id="activity"></ol></section>
  <section id="reply-section" hidden><h2>Response</h2><div id="reply" class="reply" tabindex="0"></div></section>
  <section id="review-section" hidden><div class="section-heading"><h2>Review changes</h2><button id="undo" class="quiet" type="button">Undo last apply</button></div><p class="caption">Every hunk needs a decision. Applying edits does not save your files.</p><div id="proposals"></div></section>
  <section id="command-section" hidden><h2>Command approval</h2><pre id="command-text"></pre><p class="caption">Runs against a temporary project copy. Only run tests from code you trust.</p><div class="actions"><button id="allow-command" type="button">Run command</button><button id="deny-command" class="secondary" type="button">Reject command</button></div></section>
  <div id="error" role="alert" hidden></div></main>
  <footer><form id="request" novalidate><label for="instruction">What would you like to change?</label><textarea id="instruction" rows="4" placeholder="Describe a task, or mention @file:src/app.py or @symbol:my_function" aria-describedby="input-help"></textarea><div id="input-help" class="caption">Relevant code is retrieved automatically. Your changes stay in review until accepted.</div><div class="composer-actions"><button id="cancel" class="secondary" type="button" disabled>Stop</button><button id="send" type="submit">Start task <span aria-hidden="true">↗</span></button></div></form></footer>
  <script nonce="${attribute(nonce)}" src="${attribute(jsUri)}"></script></body></html>`;
}

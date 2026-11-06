/* No provider calls, HTML injection or third-party assets in this webview. */
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let state = {
    busy: false,
    proposals: [],
    context: [],
    activity: [],
    text: "",
  };
  let composing = false;
  const decisions = new Map();
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const button = (label, action, className = "secondary") => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.className = className;
    b.addEventListener("click", action);
    return b;
  };
  const pre = (text, className) => {
    const p = document.createElement("pre");
    p.className = className;
    p.textContent =
      text.length > 3500
        ? text.slice(0, 3500) + "\n… Open the full diff to see the rest."
        : text;
    return p;
  };
  $("request").addEventListener("submit", (e) => {
    e.preventDefault();
    if (composing || state.busy) return;
    const instruction = $("instruction").value.trim();
    if (!instruction) {
      $("instruction").setAttribute("aria-invalid", "true");
      $("error").hidden = false;
      $("error").textContent = "Describe a task before starting.";
      $("instruction").focus();
      return;
    }
    $("instruction").removeAttribute("aria-invalid");
    state = {
      ...state,
      busy: true,
      status: "Starting task…",
      error: undefined,
    };
    render();
    post("run", { instruction });
  });
  $("instruction").addEventListener(
    "compositionstart",
    () => (composing = true),
  );
  $("instruction").addEventListener(
    "compositionend",
    () => (composing = false),
  );
  $("instruction").addEventListener("input", () => {
    vscode.setState({ draft: $("instruction").value });
    $("instruction").style.height = "auto";
    $("instruction").style.height =
      Math.min(220, $("instruction").scrollHeight) + "px";
  });
  $("instruction").value = vscode.getState()?.draft ?? "";
  $("cancel").addEventListener("click", () => post("cancel"));
  $("connection").addEventListener("click", () => post("status"));
  $("undo").addEventListener("click", () => post("undo"));
  $("allow-command").addEventListener("click", () =>
    post("command", { allow: true }),
  );
  $("deny-command").addEventListener("click", () =>
    post("command", { allow: false }),
  );
  function render() {
    const focusedId = document.activeElement?.id;
    $("status-text").textContent = state.status ?? "Ready";
    $("send").disabled = state.busy;
    $("cancel").disabled = !state.busy;
    $("instruction").readOnly = state.busy;
    $("welcome").hidden = !!(
      state.text ||
      state.activity.length ||
      state.proposals.length
    );
    $("error").hidden = !state.error;
    $("error").textContent = state.error ?? "";
    $("reply-section").hidden = !state.text;
    $("reply").textContent = state.text ?? "";
    $("activity-section").hidden = !state.activity.length;
    $("activity").replaceChildren(
      ...state.activity.slice(-20).map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      }),
    );
    $("context-section").hidden = !state.context.length;
    $("context-count").textContent = String(state.context.length);
    $("context-budget").textContent = state.contextBudget ?? "";
    $("context-list").replaceChildren(
      ...state.context.map((s) => {
        const li = document.createElement("li"),
          name = document.createElement("strong"),
          why = document.createElement("span");
        name.textContent = `${s.path}:${s.startLine}–${s.endLine}`;
        why.textContent = s.reason;
        li.append(name, why);
        return li;
      }),
    );
    $("command-section").hidden = !state.command;
    $("command-text").textContent = state.command
      ? `${state.command.executable} ${state.command.args.join(" ")}`
      : "";
    $("review-section").hidden = !state.proposals.length;
    $("proposals").replaceChildren(
      ...state.proposals.map((p) => {
        const article = document.createElement("article");
        article.className = "proposal";
        const top = document.createElement("div");
        top.className = "section-heading";
        const label = document.createElement("strong");
        label.textContent = `${p.hunks.length} proposed ${p.hunks.length === 1 ? "hunk" : "hunks"}`;
        top.append(
          label,
          button(
            "Open full diff",
            () => post("diff", { proposalId: p.id }),
            "quiet",
          ),
        );
        article.append(top);
        const current = decisions.get(p.id) ?? {};
        decisions.set(p.id, current);
        for (const h of p.hunks) {
          const row = document.createElement("div");
          row.className = "hunk";
          const file = document.createElement("div");
          file.className = "file";
          file.textContent = h.path;
          row.append(file, pre(h.before, "removed"), pre(h.after, "added"));
          const status = document.createElement("div");
          status.className = "decision";
          status.textContent =
            p.status === "applied"
              ? "Review applied"
              : p.status === "cancelled"
                ? "Proposal cancelled"
                : current[h.id] === "accept"
                  ? "Accepted"
                  : current[h.id] === "reject"
                    ? "Rejected"
                    : "Needs a decision";
          row.append(status);
          if (p.status !== "applied" && p.status !== "cancelled") {
            const actions = document.createElement("div");
            actions.className = "actions";
            const accept = button("Accept hunk", () => {
                current[h.id] = "accept";
                render();
              }),
              reject = button(
                "Reject hunk",
                () => {
                  current[h.id] = "reject";
                  render();
                },
                "quiet",
              );
            accept.id = "accept-" + h.id;
            reject.id = "reject-" + h.id;
            actions.append(accept, reject);
            row.append(actions);
          }
          article.append(row);
        }
        if (p.status !== "applied" && p.status !== "cancelled") {
          const apply = button(
            p.approvalPending
              ? "Apply reviewed changes"
              : "Request reviewed application",
            () => post("review", { proposalId: p.id, decisions: current }),
            "apply",
          );
          apply.disabled = p.hunks.some((h) => !current[h.id]);
          article.append(apply);
        }
        return article;
      }),
    );
    if (focusedId)
      document.getElementById(focusedId)?.focus({ preventScroll: true });
  }
  window.addEventListener("message", (event) => {
    if (event.data?.type === "state") {
      state = event.data.state;
      render();
    }
  });
  post("ready");
})();

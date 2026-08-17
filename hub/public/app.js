/* Dashboard ops view (M6): state snapshot + live SSE updates. Vanilla JS, no build step. */
"use strict";

const state = {
  plans: [], activities: [], jobs: [], nodes: [], approvals: [], gate_results: [], agent_log: [],
  agentsConfigured: false,
};

function tokenParams() {
  const t = localStorage.getItem("auth_token");
  return t ? `?token=${encodeURIComponent(t)}` : "";
}
async function api(path, opts = {}) {
  const t = localStorage.getItem("auth_token");
  const headers = { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) };
  const res = await fetch(path + (path.includes("?") ? "&" : "") + (t ? `token=${encodeURIComponent(t)}` : ""), {
    ...opts, headers: { ...headers, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    const t2 = prompt("Auth token required:");
    if (t2) { localStorage.setItem("auth_token", t2); return api(path, opts); }
  }
  return res;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function statusChip(s) {
  const cls = { passed: "ok", succeeded: "ok", approved: "ok", running: "info", leased: "info", queued: "dim", pending: "dim", ready: "info", pending_approval: "pending", repair: "pending", gate_check: "pending", escalated: "bad", failed: "bad", cancelled: "bad", done: "ok", resolved: "info", executing: "info", blocked: "bad", failed_final: "bad" }[s] ?? "dim";
  return `<span class="chip ${cls}">${esc(s)}</span>`;
}

function render() {
  // approvals
  const apEl = document.getElementById("approval-list");
  const pending = state.approvals.filter((a) => a.status === "pending");
  apEl.innerHTML = pending.length
    ? pending.map((a) => {
        const p = typeof a.payload === "string" ? JSON.parse(a.payload) : a.payload || {};
        const note = a.agent_note ? (typeof a.agent_note === "string" ? JSON.parse(a.agent_note) : a.agent_note) : null;
        const actions = a.kind === "plan_approval"
          ? `<button onclick="act('approve','${a.id}')">Approve plan</button><button class="danger" onclick="act('reject','${a.id}')">Reject</button>`
          : `<button onclick="act('resolve','${a.id}','accept_failure')">Accept failure</button><button onclick="act('resolve','${a.id}','retry')">Retry</button>`;
        return `<div class="card" id="ap-${a.id}">
          <h3>${a.kind === "plan_approval" ? "Plan approval" : "Escalation"} · ${esc(a.plan_id)}${a.activity ? " / " + esc(a.activity) : ""}</h3>
          <pre>${esc(JSON.stringify(p, null, 2))}</pre>
          ${note ? `<div class="gate-entry"><b>director:</b> ${esc(note.verdict ?? "")}<div class="audit">${esc(note.note ?? "")}</div></div>` : ""}
          <div class="actions">${actions}</div>
        </div>`;
      }).join("")
    : `<div class="chip dim">no pending approvals</div>`;

  // plans & activities
  const planEl = document.getElementById("plan-list");
  planEl.innerHTML = state.plans.map((p) => {
    const acts = state.activities.filter((a) => a.plan_id === p.id);
    return `<div class="plan-block">
      <div class="plan-head"><b>${esc(p.id)}</b> ${statusChip(p.status)}</div>
      ${acts.map((a) => `
        <div class="activity">
          <span class="title">${esc(a.id)} <span style="color:var(--dim)">— ${esc(a.title)}</span></span>
          <span class="chip dim">attempt ${a.attempt}</span>
          ${statusChip(a.status)}
        </div>`).join("")}
    </div>`;
  }).join("") || `<div class="chip dim">no plans submitted</div>`;

  // jobs
  const jobEl = document.getElementById("job-rows");
  jobEl.innerHTML = state.jobs.map((j) => {
    const ev = j.latest_event || {};
    const pct = Math.round(Number(ev.pct ?? 0));
    const cls = ["failed", "cancelled"].includes(j.status) ? "bad" : j.status === "succeeded" ? "" : "warn";
    const eta = ev.eta_s != null ? `${Math.round(Number(ev.eta_s))}s` : "–";
    return `<tr>
      <td title="${esc(j.id)}">${esc(j.id)}</td>
      <td>${esc(j.activity ?? "–")}</td>
      <td>${esc(j.node ?? "–")}</td>
      <td>${statusChip(j.status)}</td>
      <td><div class="bar ${cls}"><div style="width:${pct}%"></div></div><span style="color:var(--dim);font-size:11px">${pct}%</span></td>
      <td>${eta}</td>
      <td>${esc(ev.stage ?? "")}</td>
    </tr>`;
  }).join("");

  // nodes
  document.getElementById("node-list").innerHTML = state.nodes.length
    ? state.nodes.map((n) => `<span class="chip ${n.state === "busy" ? "info" : "ok"}">${esc(n.id)} · ${esc(n.state)}</span>`).join("")
    : `<span class="chip dim">no nodes</span>`;

  // gates
  document.getElementById("gate-list").innerHTML = state.gate_results.length
    ? state.gate_results.map((g) => {
        const checks = typeof g.checks === "string" ? JSON.parse(g.checks) : g.checks || [];
        const audit = g.audit_note ? (typeof g.audit_note === "string" ? JSON.parse(g.audit_note) : g.audit_note) : null;
        return `<div class="gate-entry">
          <b>${esc(g.activity)}</b> ${statusChip(g.verdict === "pass" ? "passed" : "failed")}
          <span style="color:var(--dim)"> · ${esc(g.reason ?? "")}</span>
          <div class="checks">${checks.map((c) => `${c.ok ? "✓" : "✗"} ${esc(c.id)}: ${esc(c.detail)}`).join("\n")}</div>
          ${audit ? `<div class="audit"><b>auditor:</b> ${esc(audit.verdict ?? "")} — ${esc(audit.note ?? "")}</div>` : ""}
        </div>`;
      }).join("")
    : `<div class="chip dim">no gate results yet</div>`;

  const agentsEl = document.getElementById("agents");
  agentsEl.textContent = state.agentsConfigured ? "agents: on" : "agents: off";
  agentsEl.className = `chip ${state.agentsConfigured ? "ok" : "dim"}`;
}

async function refresh() {
  const res = await api("/api/state");
  if (!res.ok) return;
  Object.assign(state, await res.json());
  render();
}

window.act = async function (action, id, disposition) {
  const res = await api(`/api/approvals/${id}`, {
    method: "POST",
    body: JSON.stringify({ action, disposition }),
  });
  if (!res.ok) console.error(await res.text());
  refresh();
};

function logEvent(name, data) {
  const el = document.getElementById("event-log");
  const line = document.createElement("div");
  line.className = "ev";
  const ts = new Date().toLocaleTimeString();
  line.innerHTML = `<b>[${ts}] ${esc(name)}</b> ${esc(typeof data === "object" ? JSON.stringify(data) : data)}`;
  el.prepend(line);
  while (el.children.length > 200) el.removeChild(el.lastChild);
}

function connectSSE() {
  const t = localStorage.getItem("auth_token");
  const es = new EventSource("/api/stream" + (t ? `?token=${encodeURIComponent(t)}` : ""));
  es.addEventListener("hello", () => {
    document.getElementById("conn").textContent = "live";
    document.getElementById("conn").className = "chip ok";
  });
  const interesting = ["job_event", "job_status", "activity", "plan", "approval", "gate", "node", "agent", "job_result"];
  for (const name of interesting) {
    es.addEventListener(name, (e) => {
      logEvent(name, e.data);
      refresh(); // debounce-free: demo scale, refresh is cheap
    });
  }
  es.onerror = () => {
    document.getElementById("conn").textContent = "reconnecting…";
    document.getElementById("conn").className = "chip pending";
  };
}

refresh();
connectSSE();
setInterval(refresh, 5000); // safety poll in case SSE drops silently

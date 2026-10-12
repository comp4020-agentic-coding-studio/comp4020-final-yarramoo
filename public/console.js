"use strict";
// Mission Control client. The server owns the clock and every rule: this renders
// what it is told, extrapolates the countdown between pushes, and sends actions.
// It never sends time. Every string from the server goes through esc() or textContent.
(() => {
  const root = document.getElementById("mission");
  if (!root) return;
  const code = root.dataset.code;
  const myRoles = (root.dataset.roles || "").split(" ").filter(Boolean);
  const ROLES = ["flight", "propulsion", "ground"];
  const ROLE_LABELS = { flight: "Flight Director", propulsion: "Propulsion", ground: "Ground Systems" };
  const $ = (id) => document.getElementById(id);
  const csrf = () => (document.querySelector("input[name=_csrf]") || {}).value || "";

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------------------------------------------------------------- time
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (ms) => {
    const t = Math.floor(Math.abs(ms) / 1000);
    return `T${ms < 0 ? "-" : "+"}${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  };
  const fmtSec = (s) => fmt(s * 1000);
  const win = (w) => (w ? `${fmtSec(w[0])} to ${fmtSec(w[1])}` : "any time");

  const clock = { phase: "lobby", tMs: 0, at: performance.now() };
  const setClock = (phase, tMs) => { clock.phase = phase; clock.tMs = tMs; clock.at = performance.now(); };
  const tNow = () => clock.tMs + (clock.phase === "count" ? performance.now() - clock.at : 0);
  const drawClock = () => {
    const txt = fmt(tNow());
    for (const el of document.querySelectorAll(".countdown")) if (el.textContent !== txt) el.textContent = txt;
  };
  setInterval(drawClock, 100);

  // --------------------------------------------------------------- state
  let lobby = null;
  let views = {};
  const busy = new Set();
  const lastHtml = {};
  const consoles = $("consoles");
  const outcomePanel = $("outcome-panel");

  const live = () => lobby && lobby.phase !== "lobby";

  // ------------------------------------------------------------ rendering
  const light = (cls, label) => `<span class="light ${cls}" aria-hidden="true"></span><span class="sr">${esc(label)}</span>`;
  const badge = (phase) => `<span class="phase phase-${esc(phase)}">${esc(phase === "hold" ? "HOLD" : phase.toUpperCase())}</span>`;

  const btn = (key, cls, label, data, disabled) =>
    `<button type="button" class="${cls}" data-key="${esc(key)}" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ")}${disabled || busy.has(key) ? " disabled" : ""}>${esc(label)}</button>`;

  const gauge = (v) => {
    const [ll, lh] = v.limit, [nl, nh] = v.nominal;
    const pad10 = (lh - ll) * 0.1, lo = ll - pad10, span = lh - ll + 2 * pad10;
    const pc = (x) => Math.max(0, Math.min(100, ((x - lo) / span) * 100));
    return `<div class="gauge" role="img" aria-label="${esc(v.label)} ${v.value.toFixed(1)} ${esc(v.unit)}">
      <div class="band limit" style="left:${pc(ll)}%;width:${pc(lh) - pc(ll)}%"></div>
      <div class="band nominal" style="left:${pc(nl)}%;width:${pc(nh) - pc(nl)}%"></div>
      <div class="marker${v.caution ? " caution" : ""}" style="left:${pc(v.value)}%"></div></div>`;
  };

  const stepRow = (role, s) => {
    let right;
    if (s.status === "ready") right = btn(`${role}:step:${s.id}`, "big go-btn", "Do it", { act: "step", role, stepid: s.id });
    else if (s.status === "locked") {
      const w = s.waitingOn.map((x) => x.label || `a task on ${ROLE_LABELS[x.role]}`);
      right = `<span class="st">${w.length ? "Waiting: " + esc(w.join(", ")) : "Locked"}</span>`;
    } else right = `<span class="st">${s.status === "done" ? "DONE" : "MISSED"}</span>`;
    return `<li class="step ${esc(s.status)}"><div class="step-main"><span class="step-label">${esc(s.label)}${s.required ? "" : ' <em class="opt">optional</em>'}</span>
      <span class="win">${esc(win(s.window))}</span></div>${right}</li>`;
  };

  const pollBlock = (role, v) => v.polls.map((p) => {
    const reports = Object.entries(p.reports).map(([r, rep]) => `<li class="rep ${esc(rep)}">${esc(ROLE_LABELS[r] || r)}: ${rep === "go" ? "GO" : "NO-GO"}</li>`).join("");
    let ctl = "";
    const nogo = Object.values(p.reports).includes("nogo");
    if (role === "flight" && (p.status === "ready" || p.status === "missed")) ctl = btn(`${role}:open:${p.id}`, "big", "Open poll", { act: "poll_open", role, pollid: p.id });
    else if (role === "flight" && p.status === "closed" && nogo) ctl = btn(`${role}:open:${p.id}`, "big", "Re-poll", { act: "poll_open", role, pollid: p.id });
    if (p.status === "open" && !p.myReport) {
      ctl += `<div class="pollbtns">${btn(`${role}:go:${p.id}`, "big go", "GO", { act: "poll_report", role, pollid: p.id, report: "go" })}${btn(`${role}:nogo:${p.id}`, "big nogo", "NO-GO", { act: "poll_report", role, pollid: p.id, report: "nogo" })}</div>`;
    } else if (p.status === "open") ctl += `<p class="muted">You reported ${p.myReport === "go" ? "GO" : "NO-GO"}. Waiting for ${esc(p.pending.map((r) => ROLE_LABELS[r]).join(", ") || "nobody")}.</p>`;
    return `<div class="poll ${esc(p.status)}"><div class="poll-head"><strong>${esc(p.label)}</strong> <span class="st">${esc(p.status.toUpperCase())}</span> <span class="win">${esc(win(p.window))}</span></div>
      ${reports ? `<ul class="reps">${reports}</ul>` : ""}${ctl}</div>`;
  }).join("");

  const consoleHtml = (role, v) => {
    const cautions = v.cautions.map((c) => `<li class="caution-row">${light("amber", "caution")}${esc(c)}</li>`).join("");
    const values = v.values.map((x) => `<div class="val${x.caution ? " caution" : ""}"><div class="val-head"><span>${esc(x.label)}</span>
      <span class="val-num">${x.value.toFixed(1)} <small>${esc(x.unit)}</small></span></div>${gauge(x)}</div>`).join("");
    const checks = v.crossChecks.map((x) => `<li class="check ${x.reading}">${light(x.reading === "normal" ? "green" : "red", x.reading)}${esc(x.label)}: <strong>${x.reading === "normal" ? "NORMAL" : "ABNORMAL"}</strong></li>`).join("");
    const steps = v.steps.map((s) => stepRow(role, s)).join("");
    let flight = "";
    if (role === "flight") {
      const items = (v.checklist || []).map((c) => `<li class="${esc(c.status)}"><span class="cl-role">${esc(ROLE_LABELS[c.role])}</span> ${esc(c.label)} <span class="st">${esc(c.status.toUpperCase())}</span></li>`).join("");
      const can = v.phase === "count" || v.phase === "hold";
      flight = `<section class="panel"><h3>Master checklist</h3><ul class="checklist">${items}</ul></section>
        <section class="panel controls"><h3>Flight controls</h3><div class="ctl">
        ${btn("flight:hold", "big hold-btn", "HOLD", { act: "hold", role }, v.phase !== "count")}
        ${btn("flight:resume", "big", "RESUME", { act: "resume", role }, v.phase !== "hold")}
        ${btn("flight:scrub", "big nogo", "SCRUB", { act: "scrub", role, confirm: "Scrub the mission? This ends it." }, !can)}</div></section>`;
    }
    // One string per slot, so a 1 Hz telemetry update rebuilds only the
    // telemetry slot and never replaces a button mid-press. The clock text is
    // left empty here; drawClock fills every `.countdown`.
    return [
      `<div class="console-head"><h2>${esc(ROLE_LABELS[role])}</h2><span class="mini-clock countdown"></span>${badge(v.phase)}<span class="holds">Holds ${v.holds} · window ${Math.ceil(v.holdLeftMs / 1000)}s of hold left</span></div>`,
      cautions ? `<ul class="cautions">${cautions}</ul>` : "",
      values ? `<section class="panel"><h3>Telemetry</h3>${values}</section>` : "",
      checks ? `<section class="panel"><h3>Cross-checks</h3><ul class="checks">${checks}</ul></section>` : "",
      `<section class="panel"><h3>Steps</h3><ul class="steps">${steps || '<li class="muted">None</li>'}</ul></section>`,
      v.polls.length ? `<section class="panel"><h3>Go / no-go polls</h3>${pollBlock(role, v)}</section>` : "",
      flight,
    ];
  };

  const repLine = (r) => `${esc(r.report === "go" ? "GO" : "NO-GO")} <span class="muted">(showing ${esc(r.showing.toUpperCase())})</span>`;
  const debriefHtml = (d) => {
    const rows = [];
    for (const p of d.polls) {
      const rounds = [...(p.history || []), p.reports];
      rounds.forEach((rd, i) => {
        for (const [r, rep] of Object.entries(rd)) {
          const bad = rep.report === "go" && rep.showing === "caution";
          rows.push(`<tr class="${bad ? "bad" : ""}"><td>${esc(p.label)}${rounds.length > 1 ? " (round " + (i + 1) + ")" : ""}</td><td>${esc(ROLE_LABELS[r] || r)}</td><td>${repLine(rep)}</td><td>${fmt(rep.atT)}</td><td>${bad ? "Reported GO on a caution" : ""}</td></tr>`);
        }
      });
    }
    const faults = d.faults.filter((f) => f.scheduledT !== null).map((f) =>
      `<tr><td>${esc(f.label)}</td><td>${esc(ROLE_LABELS[f.role])}</td><td>${f.real ? "REAL fault" : "Glitch"}</td><td>${f.active ? (f.resolved ? "Resolved" : "Unresolved") : "Never appeared"}</td></tr>`).join("");
    return `<h3>Poll record</h3><div class="scroll"><table><thead><tr><th>Poll</th><th>Seat</th><th>Reported</th><th>At</th><th></th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="5">No polls were held.</td></tr>'}</tbody></table></div>
      <h3>Faults</h3><div class="scroll"><table><thead><tr><th>Fault</th><th>Console</th><th>Truth</th><th>Outcome</th></tr></thead><tbody>${faults || '<tr><td colspan="4">No faults occurred.</td></tr>'}</tbody></table></div>`;
  };

  const renderOutcome = () => {
    const vs = Object.values(views);
    const out = (vs.find((v) => v.outcome) || {}).outcome || (lobby && lobby.outcome);
    const debrief = (vs.find((v) => v.debrief) || {}).debrief;
    if (!out) { outcomePanel.hidden = true; return; }
    const title = { success: "SUCCESS", explosion: "EXPLOSION", scrub: "SCRUBBED", pad_abort: "PAD ABORT" }[out.kind] || out.kind.toUpperCase();
    outcomePanel.hidden = false;
    outcomePanel.className = `outcome ${esc(out.kind)}`;
    outcomePanel.innerHTML = `<h2>${esc(title)}</h2><p class="countdown-final">${fmt(out.atT)}</p><ul>${out.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      ${debrief ? debriefHtml(debrief) : '<p class="muted">The full debrief is shown to the crew.</p>'}<p><a class="btnlink" href="/missions/${esc(code)}">Full replay</a> <a class="btnlink" href="/">Back to the hub</a></p>`;
  };

  const renderConsoles = () => {
    const done = lobby && lobby.phase === "done";
    consoles.hidden = done || myRoles.length === 0 || !live();
    if (myRoles.length === 0 && live()) $("observer-note").hidden = false;
    $("tabs").hidden = myRoles.length < 2 || done;
    consoles.dataset.n = String(myRoles.length);
    for (const role of myRoles) {
      const v = views[role];
      if (!v) continue;
      let el = $(`console-${role}`);
      if (!el) {
        el = document.createElement("section");
        el.id = `console-${role}`;
        el.className = "console";
        el.dataset.role = role;
        if (role !== activeTab) el.classList.add("inactive");
        consoles.appendChild(el);
      }
      const parts = consoleHtml(role, v);
      while (el.children.length < parts.length) el.appendChild(document.createElement("div"));
      parts.forEach((h, i) => {
        const key = `${role}:${i}`;
        if (lastHtml[key] !== h) { lastHtml[key] = h; el.children[i].innerHTML = h; }
      });
    }
    renderOutcome();
    drawClock();
  };

  let activeTab = myRoles[0];
  const tabs = $("tabs");
  for (const r of myRoles) {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.tab = r; b.textContent = ROLE_LABELS[r];
    if (r === activeTab) b.setAttribute("aria-pressed", "true");
    tabs.appendChild(b);
  }
  tabs.addEventListener("click", (e) => {
    const r = e.target instanceof HTMLElement && e.target.dataset.tab;
    if (!r) return;
    activeTab = r;
    for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.dataset.tab === r));
    for (const c of consoles.children) c.classList.toggle("inactive", c.dataset.role !== r);
  });

  // Take/Leave buttons are drawn here from the lobby message, so a seat change
  // by someone else never needs a page reload. They stay ordinary POST forms.
  const seatForms = (li, holder) => {
    const me = (root.dataset.callsign || "").toLowerCase();
    const role = li.dataset.role;
    const kind = !me ? "" : !holder ? "seat" : holder.toLowerCase() === me ? "unseat" : "";
    if (li.dataset.form === kind) return;
    li.dataset.form = kind;
    for (const f of li.querySelectorAll("form.inline")) f.remove();
    if (!kind) return;
    const f = document.createElement("form");
    f.className = "inline"; f.method = "post"; f.action = `/m/${code}/${kind}`;
    for (const [k, v] of [["_csrf", csrf()], ["role", role]]) {
      const i = document.createElement("input");
      i.type = "hidden"; i.name = k; i.value = v;
      f.appendChild(i);
    }
    const b = document.createElement("button");
    b.type = "submit"; b.textContent = kind === "seat" ? "Take seat" : "Leave seat";
    if (kind === "unseat") b.className = "secondary";
    f.appendChild(b);
    li.appendChild(f);
  };

  const renderLobby = () => {
    if (!lobby) return;
    for (const li of document.querySelectorAll("#seats li[data-role]")) {
      const holder = lobby.seats[li.dataset.role];
      const h = li.querySelector(".holder");
      h.textContent = holder || "open";
      li.classList.toggle("taken", !!holder);
      if (lobby.phase === "lobby") seatForms(li, holder);
    }
    const full = ROLES.every((r) => lobby.seats[r]);
    const start = document.querySelector("#start-form button");
    if (start) { start.disabled = !full || busy.has("start"); }
    const note = $("fill-note");
    if (note) note.textContent = full ? "All seats are filled." : "Every seat must be filled before the count can start.";
    const wasLobby = root.dataset.status === "lobby";
    root.dataset.status = lobby.phase === "lobby" ? "lobby" : lobby.phase === "done" ? "done" : "live";
    if (wasLobby && lobby.phase !== "lobby") {
      for (const f of document.querySelectorAll("#lobby form")) f.remove();
    }
    $("phase").textContent = lobby.phase;
  };

  // -------------------------------------------------------------- stream
  let source = null;
  let retry = 500;
  const status = $("conn");
  let lastMsg = performance.now();
  const connect = () => {
    if (source) source.close();
    lastMsg = performance.now();
    source = new EventSource(`/m/${code}/stream`);
    source.onopen = () => { retry = 500; status.hidden = true; };
    source.onmessage = (e) => {
      lastMsg = performance.now();
      status.hidden = true;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "lobby") {
        lobby = m;
        setClock(m.phase, m.tMs);
        renderLobby();
        renderConsoles();
      } else if (m.type === "views") {
        Object.assign(views, m.views);
        const any = Object.values(m.views)[0];
        if (any) setClock(any.phase, any.tMs);
        renderConsoles();
      } else if (m.type === "reseat") {
        connect();
      }
      drawClock();
    };
    source.onerror = () => {
      status.hidden = false;
      if (source.readyState === EventSource.CLOSED) setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
    };
  };

  // A dropped Wi-Fi link often closes nothing: the stream just goes quiet and no
  // error fires. A live mission is pushed to every second, so five quiet seconds
  // means the link is dead; say so and reconnect (a fresh connection starts with
  // a full snapshot). Lobbies and finished missions are legitimately quiet.
  setInterval(() => {
    if (!lobby || lobby.phase === "lobby" || lobby.phase === "done") return;
    if (performance.now() - lastMsg < 5000) return;
    status.hidden = false;
    // Give this attempt its own five seconds; otherwise a slow link would be
    // reconnected every second, each attempt killing the last before it opens.
    lastMsg = performance.now();
    connect();
  }, 1000);

  // ------------------------------------------------------------- actions
  const err = $("error");
  const send = async (key, fields) => {
    busy.add(key);
    for (const b of document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`)) b.disabled = true;
    const body = new URLSearchParams({ _csrf: csrf(), ...fields });
    // A slow or dead connection must not leave the button stuck: give up after
    // 10 s. The action may still have reached the server; the next push shows it.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`/m/${code}/act`, { method: "POST", body, signal: ctrl.signal });
      const out = await res.json();
      err.textContent = out.ok ? "" : out.error || "rejected";
    } catch (e) {
      err.textContent = e && e.name === "AbortError" ? "No reply from mission control — try again" : "could not reach the server";
    } finally {
      clearTimeout(timer);
      busy.delete(key);
      for (const b of document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`)) b.disabled = false;
      renderLobby();
    }
  };

  consoles.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("button[data-act]") : null;
    if (!b || b.disabled) return;
    if (b.dataset.confirm && !window.confirm(b.dataset.confirm)) return;
    const f = { role: b.dataset.role, type: b.dataset.act };
    if (b.dataset.stepid) f.stepId = b.dataset.stepid;
    if (b.dataset.pollid) f.pollId = b.dataset.pollid;
    if (b.dataset.report) f.report = b.dataset.report;
    send(b.dataset.key, f);
  });

  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-action")) return;
    e.preventDefault();
    send("start", Object.fromEntries([...new FormData(form)].filter(([k]) => k !== "_csrf")));
  });

  const copy = $("copy-link");
  if (copy) copy.addEventListener("click", async () => {
    const url = `${location.origin}/m/${code}`;
    try { await navigator.clipboard.writeText(url); copy.textContent = "Copied"; }
    catch { window.prompt("Copy this link", url); }
    setTimeout(() => { copy.textContent = "Copy link"; }, 1500);
  });

  connect();
})();

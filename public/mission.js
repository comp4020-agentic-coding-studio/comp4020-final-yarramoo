// Minimal client for phase 3. Phase 4 replaces the <pre> rendering with real
// consoles. The server owns the clock: this only renders what it is told and
// extrapolates the count between pushes. It never sends time.
(() => {
  const root = document.getElementById("mission");
  if (!root) return;
  const code = root.dataset.code;
  const $ = (id) => document.getElementById(id);
  const clock = { phase: "lobby", tMs: 0, serverNow: 0, at: 0 };
  let source = null;
  let retry = 500;

  const fmt = (ms) => {
    const t = Math.abs(Math.trunc(ms / 1000));
    const sign = ms < 0 ? "-" : "+";
    return `T${sign}${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  };
  // T from the last push, advanced by local elapsed time only while counting.
  const tNow = () => clock.tMs + (clock.phase === "count" ? Date.now() - clock.at : 0);
  const drawClock = () => {
    $("clock").textContent = fmt(tNow());
  };
  setInterval(drawClock, 200);

  const onLobby = (m) => {
    clock.phase = m.phase;
    clock.tMs = m.tMs;
    clock.at = Date.now();
    $("phase").textContent = m.phase;
    $("outcome").textContent = m.outcome ? `${m.outcome.kind}: ${m.outcome.reasons.join("; ")}` : "";
    root.dataset.status = m.phase === "lobby" ? "lobby" : m.phase === "done" ? "done" : "live";
    for (const li of document.querySelectorAll("#seats li[data-role]")) {
      li.querySelector(".holder").textContent = m.seats[li.dataset.role] || "open";
    }
    drawClock();
  };

  const onViews = (m) => {
    for (const [role, v] of Object.entries(m.views)) {
      const pre = document.querySelector(`#console-${role} pre.view`);
      if (pre) pre.textContent = JSON.stringify(v, null, 1);
    }
  };

  const connect = () => {
    if (source) source.close();
    source = new EventSource(`/m/${code}/stream`);
    source.onopen = () => { retry = 500; };
    source.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "lobby") onLobby(m);
      else if (m.type === "views") onViews(m);
      else if (m.type === "reseat") connect();
    };
    source.onerror = () => {
      // EventSource retries on its own, but a closed one (e.g. a 404) does not.
      if (source.readyState === EventSource.CLOSED) setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
    };
  };
  connect();

  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-action")) return;
    e.preventDefault();
    const err = $("error");
    err.textContent = "";
    try {
      const res = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)) });
      const out = await res.json();
      if (!out.ok) err.textContent = out.error || "rejected";
    } catch {
      err.textContent = "could not reach the server";
    }
  });
})();

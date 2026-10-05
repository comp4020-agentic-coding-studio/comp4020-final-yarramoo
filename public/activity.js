// Site-wide "something just happened" toasts.
// Transport: rides live.js's single shared EventSource (the #activity element subscribes to the
// `activity` topic with data-live-mode="none"), so every page keeps exactly one connection
// instead of opening a second one just for toasts. We only listen to live.js's "live" event.
(() => {
  const region = document.getElementById("activity");
  if (!region) return;
  const list = region.querySelector(".activity-list");
  const pauseBtn = region.querySelector(".activity-pause");
  const me = document.body.dataset.userId || "";
  const blocked = (document.body.dataset.blockedIds || "").split(",").filter(Boolean);
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MAX_SHOWN = 3, MAX_QUEUE = 5, GAP_MS = 3000, LIFE_MS = 6000;
  let paused = false, last = 0, timer = 0;
  const queue = [];
  try { paused = localStorage.getItem("activity-paused") === "1"; } catch { /* storage blocked */ }
  const syncBtn = () => {
    pauseBtn.hidden = false;
    pauseBtn.setAttribute("aria-pressed", String(paused));
    pauseBtn.textContent = paused ? "Resume activity" : "Pause activity";
  };
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    try { localStorage.setItem("activity-paused", paused ? "1" : "0"); } catch { /* ignore */ }
    if (paused) queue.length = 0;
    syncBtn();
  });
  syncBtn();

  const KINDS = ["project-posted", "project-finished", "project-started", "team-grew", "update-posted", "question-asked", "answer-accepted"];
  const art = (kind) => {
    if (kind === "team-grew") return '<span class="activity-art"><i class="piece a"></i><i class="piece b"></i></span>';
    if (kind === "project-finished") return '<span class="activity-art burst">' + "<i></i>".repeat(8) + "</span>";
    return '<span class="activity-art"></span>';
  };

  function show(ev) {
    const d = ev.data;
    while (list.children.length >= MAX_SHOWN) list.firstElementChild.remove();
    const t = document.createElement("div");
    t.className = "activity-toast kind-" + d.kind + (reduce ? " calm" : "");
    if (d.category) t.dataset.category = d.category;
    if (d.region) t.dataset.region = d.region;
    t.innerHTML = art(d.kind) + '<span class="activity-text">' + ev.html + '</span><button type="button" class="activity-close" aria-label="Dismiss">×</button>';
    t.querySelector(".activity-close").addEventListener("click", () => t.remove());
    list.appendChild(t);
    setTimeout(() => t.remove(), LIFE_MS);
  }

  function pump() {
    timer = 0;
    if (paused || !queue.length) return;
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) { timer = setTimeout(pump, wait); return; }
    last = Date.now();
    show(queue.shift());
    if (queue.length) timer = setTimeout(pump, GAP_MS);
  }

  document.addEventListener("live", (e) => {
    const p = e.detail;
    if (!p || p.type !== "activity" || !p.data || !p.html || !KINDS.includes(p.data.kind)) return;
    if (paused) return;
    if (me && String(p.data.actor) === me) return; // your own actions don't toast you
    if (p.data.actor != null && blocked.includes(String(p.data.actor))) return; // you blocked this member
    if (queue.length >= MAX_QUEUE) return;
    queue.push(p);
    if (!timer) pump();
  });
})();

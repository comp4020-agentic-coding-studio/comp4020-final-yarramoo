// Live hub: on a ping, fetch the sections fragment and swap #hub, unless the
// reader is in the middle of a form.
(() => {
  const root = document.getElementById("hub");
  if (!root) return;
  let busy = false, pending = false;
  const refresh = async () => {
    const a = document.activeElement;
    if (busy || (a && a !== document.body && a.closest && a.closest("form") && a.matches("input, textarea, select"))) { pending = true; return; }
    busy = true; pending = false;
    try {
      const res = await fetch("/hub/fragment", { credentials: "same-origin" });
      if (res.ok) root.innerHTML = await res.text();
    } catch { /* next ping */ }
    busy = false;
  };
  document.addEventListener("focusout", () => { if (pending) setTimeout(refresh, 100); });
  const es = new EventSource("/hub/stream");
  let first = true;
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "hub") refresh();
    else if (m.type === "hello" && !first) refresh();
    first = false;
  };
  setInterval(() => { if (!document.hidden) refresh(); }, 30_000); // keeps ages and clocks fresh
})();

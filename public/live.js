// Generic live-update client.
// Markup:  <div data-live-topic="project:12" data-live-target="#updates" data-live-mode="prepend"></div>
//   data-live-topic   topic(s) to subscribe to (space-separated); one EventSource is shared per page.
//   data-live-target  CSS selector to modify when an event for that topic carries `html`
//                     (the element itself if omitted).
//   data-live-mode    replace (default) | prepend | append | outer
// Server events: SSE with JSON data {topic, type, html?, data?}. Also dispatches a
// bubbling "live" CustomEvent on document (detail = the payload) for custom handling.
(() => {
  const els = [...document.querySelectorAll("[data-live-topic]")];
  if (!els.length || !window.EventSource) return;
  const topics = new Set();
  for (const el of els) for (const t of el.dataset.liveTopic.split(/\s+/).filter(Boolean)) topics.add(t);
  const es = new EventSource("/events?" + [...topics].map((t) => "topic=" + encodeURIComponent(t)).join("&"));
  const types = new Set(["message"]);
  const handle = (ev) => {
    let p;
    try { p = JSON.parse(ev.data); } catch { return; }
    document.dispatchEvent(new CustomEvent("live", { detail: p }));
    if (!p.html) return;
    for (const el of els) {
      if (!el.dataset.liveTopic.split(/\s+/).includes(p.topic)) continue;
      const target = el.dataset.liveTarget ? document.querySelector(el.dataset.liveTarget) : el;
      if (!target) continue;
      const mode = el.dataset.liveMode || "replace";
      if (mode === "prepend") target.insertAdjacentHTML("afterbegin", p.html);
      else if (mode === "append") target.insertAdjacentHTML("beforeend", p.html);
      else if (mode === "outer") target.outerHTML = p.html;
      else target.innerHTML = p.html;
    }
  };
  // Server uses named SSE events (event: <type>); listen for any type via a Proxy-free trick:
  // register a few common names, plus default "message".
  for (const t of ["message", "update", "created", "changed", "removed", "request", "decision", "ready"]) {
    types.add(t);
    es.addEventListener(t, handle);
  }
})();

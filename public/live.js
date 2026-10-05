// Generic live-update client.
// Markup:  <div data-live-topic="project:12" data-live-target="#updates" data-live-mode="prepend"></div>
//   data-live-topic   topic(s) to subscribe to (space-separated); one EventSource is shared per page.
//   data-live-target  CSS selector to modify when an event for that topic carries `html`
//                     (the element itself if omitted).
//   data-live-types   optional space/comma list of event types this element reacts to (default: all).
//   data-live-mode    replace (default) | prepend | append | outer | none (subscribe only, rely on the "live" event)
// An event whose data.target is a selector replaces that element's outerHTML instead.
// Server events: unnamed SSE messages with JSON data {topic, type, html?, data?}. Also dispatches a
// bubbling "live" CustomEvent on document (detail = the payload) for custom handling.
(() => {
  const els = [...document.querySelectorAll("[data-live-topic]")];
  if (!els.length || !window.EventSource) return;
  const topics = new Set();
  for (const el of els) for (const t of el.dataset.liveTopic.split(/\s+/).filter(Boolean)) topics.add(t);
  const es = new EventSource("/events?" + [...topics].map((t) => "topic=" + encodeURIComponent(t)).join("&"));
  const handle = (ev) => {
    let p;
    try { p = JSON.parse(ev.data); } catch { return; }
    document.dispatchEvent(new CustomEvent("live", { detail: p }));
    if (!p.html) return;
    // An event with data.target (a selector) replaces that element in place, once, if this page
    // listens to the topic; it never goes through the per-element modes below.
    if (p.data && typeof p.data.target === "string") {
      if (!els.some((el) => el.dataset.liveTopic.split(/\s+/).includes(p.topic))) return;
      let t = null;
      try { t = document.querySelector(p.data.target); } catch { /* bad selector */ }
      if (t) t.outerHTML = p.html;
      return;
    }
    for (const el of els) {
      if (el.dataset.liveMode === "none") continue; // element only subscribes; a "live" listener handles the event
      if (!el.dataset.liveTopic.split(/\s+/).includes(p.topic)) continue;
      if (el.dataset.liveTypes && !el.dataset.liveTypes.split(/[\s,]+/).includes(p.type)) continue;
      const target = el.dataset.liveTarget ? document.querySelector(el.dataset.liveTarget) : el;
      if (!target) continue;
      const mode = el.dataset.liveMode || "replace";
      if (mode === "prepend") target.insertAdjacentHTML("afterbegin", p.html);
      else if (mode === "append") target.insertAdjacentHTML("beforeend", p.html);
      else if (mode === "outer") target.outerHTML = p.html;
      else target.innerHTML = p.html;
    }
  };
  es.onmessage = handle;
})();

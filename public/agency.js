// Live agency page: on a ping, fetch the page and swap <main>, unless the
// reader is in the middle of a form.
(() => {
  let busy = false, pending = false;
  const refresh = async () => {
    const a = document.activeElement;
    if (busy || (a && a.closest && a.closest("form") && a !== document.body)) { pending = true; return; }
    busy = true; pending = false;
    try {
      const res = await fetch("/agency", { credentials: "same-origin" });
      if (res.ok) {
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        const next = doc.querySelector("main");
        const cur = document.querySelector("main");
        if (next && cur) cur.innerHTML = next.innerHTML.replace(/<script[^>]*agency\.js[^>]*><\/script>/, "");
      }
    } catch { /* try again on the next ping */ }
    busy = false;
  };
  document.addEventListener("focusout", () => { if (pending) setTimeout(refresh, 100); });
  const es = new EventSource("/agency/stream");
  let first = true;
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "agency") refresh();
    else if (m.type === "hello" && !first) refresh(); // reconnected: catch up
    first = false;
  };
})();

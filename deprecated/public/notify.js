// Keeps the nav "Inbox" badge and the document title prefix in step with the unread count.
// Rides live.js's shared EventSource (layout subscribes the user's topic with data-live-mode="none").
(() => {
  const badge = document.querySelector(".unread-count");
  if (!badge) return;
  const base = document.title.replace(/^\(\d+\) /, "");
  const set = (n) => {
    badge.textContent = String(n);
    badge.hidden = !(n > 0);
    document.title = n > 0 ? "(" + n + ") " + base : base;
  };
  set(Number(badge.dataset.count) || 0);
  document.addEventListener("live", (e) => {
    const p = e.detail;
    if (!p || p.type !== "notification" || !p.data || typeof p.data.unread !== "number") return;
    set(p.data.unread);
    const empty = document.getElementById("inbox-empty");
    if (empty) empty.hidden = true;
  });
})();

// Keeps the vote counts on a formed team's project page current. Votes are private to the team, so
// they arrive on each member's own user topic (the layout already subscribes it) as type "votes".
(() => {
  const root = document.getElementById("leader-vote");
  if (!root) return;
  document.addEventListener("live", (e) => {
    const p = e.detail;
    if (!p || p.type !== "votes" || !p.data || String(p.data.project) !== root.dataset.project) return;
    for (const li of root.querySelectorAll("li[data-candidate]")) {
      const id = li.dataset.candidate;
      const n = p.data.counts[id] || 0;
      const el = li.querySelector("[data-votes]");
      if (el) el.textContent = n + (n === 1 ? " vote" : " votes");
      const mine = String(p.data.mine) === id;
      li.classList.toggle("voted", mine);
      const btn = li.querySelector("button");
      if (btn) {
        btn.textContent = mine ? "Your vote" : "Vote";
        btn.classList.toggle("secondary", !mine);
      }
    }
  });
})();

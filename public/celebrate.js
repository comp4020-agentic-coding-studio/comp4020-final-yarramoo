// Own-action celebrations (body[data-celebrate]) and the "N new projects" pill on filtered browse views.
// Styles live in the `celebrate` block of style.css. Transform/opacity only; reduced motion = static stamp + fade.
(() => {
  const kind = document.body.dataset.celebrate;
  const title = document.querySelector("article.project h1");
  if ((kind === "posted" || kind === "finished") && title) {
    const finished = kind === "finished";
    const msg = document.createElement("div");
    msg.className = "celebrate-msg";
    msg.setAttribute("aria-live", "polite");
    title.after(msg);
    const stamp = document.createElement("span");
    stamp.className = "celebrate-stamp " + kind;
    stamp.textContent = finished ? "Finished" : "Posted";
    stamp.setAttribute("aria-hidden", "true");
    let anchor = msg;
    if (finished) {
      const badge = document.querySelector("article.project .badges .badge");
      if (badge) {
        badge.classList.add("celebrate-anchor");
        anchor = badge;
        const layer = document.createElement("div");
        layer.className = "celebrate-layer";
        layer.setAttribute("aria-hidden", "true");
        const r = badge.getBoundingClientRect();
        layer.style.left = r.left + r.width / 2 + "px";
        layer.style.top = r.top + r.height / 2 + "px";
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2 + (i % 3) * 0.2, d = 50 + ((i * 37) % 60);
          const p = document.createElement("i");
          p.style.setProperty("--x", Math.cos(a) * d + "px");
          p.style.setProperty("--y", Math.sin(a) * d - 20 + "px");
          p.style.setProperty("--r", (i * 83) % 360 + "deg");
          p.style.animationDelay = (i % 6) * 25 + "ms";
          layer.appendChild(p);
        }
        document.body.appendChild(layer);
        setTimeout(() => layer.remove(), 1700);
      }
    } else {
      title.classList.add("celebrate-print");
    }
    msg.before(stamp);
    // Fill the live region after it is in the DOM so screen readers announce it.
    setTimeout(() => {
      msg.textContent = finished ? "Nice work. It's now on the Finished builds page." : "Your project is live — people nearby can now ask to join.";
    }, 50);
  }

  // Filtered browse: count incoming project-new events instead of inserting them.
  const results = document.querySelector("[data-new-pill]");
  if (results) {
    let n = 0, pill = null;
    document.addEventListener("live", (e) => {
      if (!e.detail || e.detail.type !== "project-new") return;
      n++;
      if (!pill) {
        pill = document.createElement("a");
        pill.className = "new-pill";
        pill.href = location.href;
        pill.setAttribute("role", "status");
        results.before(pill);
      }
      pill.textContent = n + " new project" + (n === 1 ? "" : "s") + " — refresh";
    });
  }
})();

// Header nav: the main menu is a <details> that is always open on wide screens
// and collapsed on phones; dropdown groups close on outside click / Escape.
(() => {
  const menu = document.querySelector("header.site details.menu");
  if (!menu) return;
  const mq = matchMedia("(max-width: 600px)");
  const sync = () => { menu.open = !mq.matches; };
  sync();
  mq.addEventListener("change", sync);
  const groups = () => document.querySelectorAll("header.site details.group");
  document.addEventListener("click", (e) => {
    for (const g of groups()) if (!g.contains(e.target)) g.open = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const g of groups()) if (g.open) { g.open = false; g.querySelector("summary").focus(); }
  });
  for (const g of groups()) g.addEventListener("toggle", () => {
    if (g.open) for (const o of groups()) if (o !== g) o.open = false;
  });
})();

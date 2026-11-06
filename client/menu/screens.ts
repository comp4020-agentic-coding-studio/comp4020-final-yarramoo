// The menu screens. Each renderer fills `ctx.panel` and may return a cleanup (timers, pollers).
import { fetchLive, deathLine, relTime, startPoll, type Live } from "./live.ts";
import type { Route } from "./router.ts";

export interface Ctx {
  root: HTMLElement;
  panel: HTMLElement;
  go: (r: Route) => void;
  back: () => void;
  ensureName: () => Promise<void>;
  refreshName: () => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", `mn-btn ${cls}`, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const LOGO_W = 83;
const LOGO_H = 22;

function logo(panel: HTMLElement): HTMLImageElement {
  const img = el("img", "mn-logo");
  img.src = "/logo/simulta-wordmark.png";
  img.alt = "Simulta";
  const fit = () => {
    const cs = getComputedStyle(panel);
    const avail = Math.min(panel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), innerWidth * 0.8);
    const s = Math.max(3, Math.min(8, Math.floor(avail / LOGO_W)));
    img.width = LOGO_W * s;
    img.height = LOGO_H * s;
  };
  fit();
  addEventListener("resize", fit);
  img.dataset.cleanup = "1";
  (img as unknown as { _off: () => void })._off = () => removeEventListener("resize", fit);
  requestAnimationFrame(fit);
  return img;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function titleScreen(ctx: Ctx): () => void {
  const { panel } = ctx;
  panel.classList.add("title");
  const img = logo(panel);
  const h1 = el("h1", "mn-logo-h");
  h1.dataset.focus = "1";
  h1.append(img);
  const tag = el("p", "mn-tag", "A shared world of sand, water, fire and spells.");
  const btns = el("div", "mn-bigbtns");
  btns.append(button("New game", "big", () => ctx.go({ kind: "types" })), button("Join game", "big water", () => ctx.go({ kind: "join" })));

  const live = el("p", "mn-live");
  live.hidden = true;
  const dot = el("span", "mn-dot");
  dot.setAttribute("aria-hidden", "true");
  const liveText = el("span");
  live.append(dot, liveText);

  const logWrap = el("div", "mn-deaths");
  logWrap.hidden = true;
  const logHead = el("p", "mn-fine mn-label", "Recent deaths");
  const log = el("ul", "mn-log");
  log.setAttribute("aria-live", "polite");
  log.setAttribute("aria-label", "Recent deaths");
  logWrap.append(logHead, log);
  panel.append(h1, tag, btns, live, logWrap);

  // Death log: keyed by the entry so only new ones slide in; times tick each second.
  const seen = new Set<string>();
  let first = true;
  let last: Live | null = null;
  const MAX = 5;
  const paintTimes = () => {
    if (!last) return;
    const now = Date.now();
    log.querySelectorAll<HTMLElement>("[data-at]").forEach((li) => {
      (li.querySelector(".t") as HTMLElement).textContent = relTime(now - Number(li.dataset.at));
    });
  };
  const apply = (j: Live | null) => {
    last = j;
    if (!j) {
      live.hidden = true;
      logWrap.hidden = true;
      return;
    }
    live.hidden = false;
    liveText.textContent = j.players > 0 ? `${plural(j.players, "player", "players")} live in ${plural(j.rooms, "room", "rooms")}` : "Nobody's playing right now. Start something.";
    dot.classList.toggle("off", j.players === 0);
    logWrap.hidden = false;
    const rows = j.deaths.slice(0, MAX);
    log.replaceChildren();
    if (!rows.length) {
      const li = el("li", "mn-fine", "No deaths yet. Suspiciously peaceful.");
      log.append(li);
    }
    rows.forEach((d, i) => {
      const key = `${d.at}|${d.victim}|${d.cause}`;
      const li = el("li", "mn-death");
      li.dataset.at = String(d.at);
      li.style.opacity = String(Math.max(0.3, 1 - i * 0.17));
      if (!first && !seen.has(key)) li.classList.add("in");
      seen.add(key);
      const t = el("span", "t");
      const txt = el("span", "x", deathLine(d)); // textContent only: a name is user input
      li.append(txt, t);
      log.append(li);
    });
    first = false;
    paintTimes();
  };
  const stopPoll = startPoll(async () => apply(await fetchLive()), 5000);
  const tick = setInterval(paintTimes, 1000);
  return () => {
    stopPoll();
    clearInterval(tick);
    (img as unknown as { _off: () => void })._off();
    panel.classList.remove("title");
  };
}

export function renderScreen(r: Route, ctx: Ctx): (() => void) | void {
  switch (r.kind) {
    default:
      return titleScreen(ctx);
  }
}

// The menu screens. Each renderer fills `ctx.panel` and may return a cleanup (timers, pollers).
import { CONFIG_BYTES, CONFIG_FIELDS, SIZE_DIMS, SURVIVAL, encodeConfig, type RoomConfig } from "../../shared/room.ts";
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

const isTouch = () => matchMedia("(pointer: coarse)").matches && innerWidth < 900;

type GameType = "survival" | "deathmatch";
const DEATHMATCH: RoomConfig = { terrain: 0, size: 1, avatars: 1, damage: 2, spells: 0, brushes: 0, death: 0, respawnSecs: 3, pickupRespawn: 1, round: 0, maxPlayers: 8, enemies: 0 };
const TYPES: Record<GameType, { title: string; blurb: string; badge: string; cls: string; icon: string; cfg: RoomConfig }> = {
  survival: { title: "Survival", blurb: "Descend together. One life. Beat the boss.", badge: "Co-op", cls: "moss", icon: "/icons/survival.png", cfg: SURVIVAL },
  deathmatch: { title: "Deathmatch", blurb: "Fight and respawn. PvP.", badge: "PvP", cls: "lava", icon: "/icons/deathmatch.png", cfg: DEATHMATCH },
};

function icon(src: string): HTMLImageElement {
  const i = el("img", "mn-icon");
  i.src = src;
  i.alt = "";
  i.width = 88;
  i.height = 88;
  i.onerror = () => (i.style.display = "none");
  return i;
}

function heading(text: string, sub?: string): HTMLElement {
  const wrap = el("div", "mn-head");
  const h = el("h1", "mn-h", text);
  h.dataset.focus = "1";
  wrap.append(h);
  if (sub) wrap.append(el("p", "mn-sub", sub));
  return wrap;
}

function backRow(ctx: Ctx, ...extra: HTMLElement[]): HTMLElement {
  const row = el("div", "mn-row mn-actions");
  row.append(button("Back", "ghost", ctx.back), ...extra);
  return row;
}

function typesScreen(ctx: Ctx): void {
  const { panel } = ctx;
  panel.append(heading("New game", "Choose a type"));
  const touch = isTouch();
  const cards = el("div", "mn-cards");
  for (const key of ["survival", "deathmatch"] as GameType[]) {
    const t = TYPES[key];
    const c = el("button", `mn-card ${t.cls}`);
    c.type = "button";
    const body = el("span", "mn-card-body");
    body.append(el("span", "mn-card-title", t.title), el("span", "mn-card-text", t.blurb));
    const badges = el("span", "mn-badges");
    badges.append(el("span", `mn-badge ${t.cls}`, t.badge));
    if (touch) badges.append(el("span", "mn-fine", "Desktop to play"));
    body.append(badges);
    c.append(icon(t.icon), body);
    c.addEventListener("click", () => ctx.go({ kind: "settings", type: key }));
    cards.append(c);
  }
  const sb = el("button", "mn-card sand");
  sb.type = "button";
  const sbody = el("span", "mn-card-body");
  const sbadges = el("span", "mn-badges");
  sbadges.append(el("span", "mn-badge sand", "No damage"));
  sbody.append(el("span", "mn-card-title", "Sandbox"), el("span", "mn-card-text", "Paint the shared world. Always on."), sbadges);
  sb.append(icon("/icons/sandbox.png"), sbody);
  sb.addEventListener("click", () => {
    ctx.ensureName().then(() => (location.href = "/sandbox")).catch(() => {});
  });
  cards.append(sb);
  panel.append(cards, backRow(ctx));
}

/** A labelled group of buttons where exactly one is pressed (aria-pressed toggles, real buttons). */
function segmented<T extends string | number>(opts: { value: T; label: string; sub?: string }[], initial: T, onPick: (v: T) => void, cls = ""): HTMLElement & { set: (v: T) => void } {
  const wrap = el("div", `mn-seg ${cls}`);
  wrap.setAttribute("role", "group");
  const btns: [T, HTMLButtonElement][] = [];
  const paint = (v: T) => btns.forEach(([k, b]) => b.setAttribute("aria-pressed", String(k === v)));
  for (const o of opts) {
    const b = el("button", "mn-segbtn");
    b.type = "button";
    b.append(el("span", "mn-segl", o.label));
    if (o.sub) b.append(el("span", "mn-segs", o.sub));
    b.addEventListener("click", () => {
      paint(o.value);
      onPick(o.value);
    });
    btns.push([o.value, b]);
    wrap.append(b);
  }
  paint(initial);
  return Object.assign(wrap, { set: paint });
}

function stepper(label: string, min: number, max: number, initial: number, onChange: (v: number) => void): { el: HTMLElement; set: (v: number) => void } {
  const wrap = el("div", "mn-stepper");
  const lab = el("span", "mn-steplab", label);
  const out = el("output", "mn-stepval", String(initial));
  const dec = button("-", "ghost small", () => set(v - 1));
  const inc = button("+", "ghost small", () => set(v + 1));
  dec.setAttribute("aria-label", `Less ${label}`);
  inc.setAttribute("aria-label", `More ${label}`);
  let v = initial;
  const set = (n: number) => {
    v = Math.max(min, Math.min(max, n));
    out.textContent = String(v);
    dec.disabled = v <= min;
    inc.disabled = v >= max;
    onChange(v);
  };
  dec.disabled = v <= min;
  inc.disabled = v >= max;
  wrap.append(lab, dec, out, inc);
  return { el: wrap, set: (n) => { v = n; out.textContent = String(n); dec.disabled = n <= min; inc.disabled = n >= max; } };
}

const SIZE_TEXT = ["Small, 512 x 512: a quick round", "Medium, 1024 x 768: the usual", "Large, 2048 x 1536: a long expedition"];

function settingsScreen(type: GameType, ctx: Ctx): () => void {
  const { panel } = ctx;
  const t = TYPES[type];
  panel.classList.add("themed", type);
  let cfg: RoomConfig = { ...t.cfg };
  let visibility: "public" | "unlisted" = "public";

  const wrap = el("form", "mn-form");
  wrap.noValidate = true;
  wrap.append(heading(`${t.title} settings`, t.blurb));

  const nameLab = el("label", "mn-field");
  nameLab.append(el("span", "mn-label mn-fine", "Room name"));
  const nameIn = el("input", "mn-input");
  nameIn.maxLength = 32;
  nameIn.placeholder = `${t.title} room`;
  nameLab.append(nameIn);

  const advInputs = new Map<keyof RoomConfig, HTMLInputElement>();
  const sync = () => advInputs.forEach((inp, k) => (inp.value = String(cfg[k])));

  const sizeBlock = el("div", "mn-field");
  sizeBlock.append(el("span", "mn-label mn-fine", "World size"));
  const sizeNote = el("p", "mn-fine", SIZE_TEXT[cfg.size]);
  const sizePick = segmented([0, 1, 2].map((i) => ({ value: i, label: "SML"[i], sub: `${SIZE_DIMS[i][0]}x${SIZE_DIMS[i][1]}` })), cfg.size, (v) => {
    cfg = { ...cfg, size: v };
    sizeNote.textContent = SIZE_TEXT[v];
    sync();
  }, "three");
  sizeBlock.append(sizePick, sizeNote);

  const mp = stepper("max players", 2, 8, cfg.maxPlayers, (v) => {
    cfg = { ...cfg, maxPlayers: v };
    sync();
  });
  const opts = el("div", "mn-field");
  opts.append(el("span", "mn-label mn-fine", "Rules"));
  let rs: ReturnType<typeof stepper> | null = null;
  if (type === "deathmatch") {
    rs = stepper("respawn secs", 1, 10, cfg.respawnSecs, (v) => {
      cfg = { ...cfg, respawnSecs: v };
      sync();
    });
    opts.append(rs.el);
  }
  opts.append(mp.el);

  const visBlock = el("div", "mn-field");
  visBlock.append(el("span", "mn-label mn-fine", "Who can join"));
  const visNote = el("p", "mn-fine", "Listed in Join game for anyone.");
  visBlock.append(
    segmented<"public" | "unlisted">([{ value: "public", label: "Public" }, { value: "unlisted", label: "Private", sub: "link only" }], "public", (v) => {
      visibility = v;
      visNote.textContent = v === "public" ? "Listed in Join game for anyone." : "Not listed. Only people with the link can join.";
    }, "two"),
    visNote,
  );

  const adv = el("details", "mn-adv");
  adv.append(el("summary", "", "Advanced"));
  const grid = el("div", "mn-advgrid");
  for (const f of CONFIG_FIELDS) {
    const lab = el("label", "mn-advf");
    lab.append(el("span", "mn-fine", `${f.key} (${f.min}-${f.max})`));
    const inp = el("input", "mn-input small");
    inp.type = "number";
    inp.min = String(f.min);
    inp.max = String(f.max);
    inp.value = String(cfg[f.key]);
    inp.addEventListener("change", () => {
      cfg = { ...cfg, [f.key]: Number(inp.value) };
      if (f.key === "maxPlayers") mp.set(cfg.maxPlayers);
      if (f.key === "size") {
        sizePick.set(cfg.size);
        sizeNote.textContent = SIZE_TEXT[cfg.size] ?? "";
      }
      if (f.key === "respawnSecs") rs?.set(cfg.respawnSecs);
    });
    advInputs.set(f.key, inp);
    lab.append(inp);
    grid.append(lab);
  }
  adv.append(grid);

  const err = el("p", "mn-err");
  err.setAttribute("role", "alert");
  err.hidden = true;
  const create = el("button", `mn-btn big ${t.cls}`, "Create");
  create.type = "submit";
  const actions = el("div", "mn-row mn-actions");
  actions.append(button("Back", "ghost", ctx.back), create);
  wrap.append(nameLab, sizeBlock, opts, visBlock, adv, err, actions);
  panel.append(wrap);

  wrap.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameIn.value.trim() || `${t.title} room`;
    const bytes = encodeConfig(cfg);
    if (bytes.length !== CONFIG_BYTES) {
      err.hidden = false;
      err.textContent = "Bad config.";
      return;
    }
    create.disabled = true;
    err.hidden = true;
    const b64 = btoa(String.fromCharCode(...bytes));
    ctx
      .ensureName()
      .then(() => fetch("/api/rooms", { method: "POST", body: JSON.stringify({ name, mode: type, config: b64, visibility }) }))
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({ error: "failed" }));
          throw new Error(j.error === "rate_limited" ? "Too many rooms today; try again tomorrow." : `Could not create the room (${j.error ?? r.status}).`);
        }
        const j = (await r.json()) as { code: string };
        if (visibility === "unlisted") ctx.go({ kind: "share", code: j.code });
        else location.href = `/r/${j.code}`;
      })
      .catch((e2) => {
        create.disabled = false;
        if ((e2 as Error).message === "cancelled") return;
        err.hidden = false;
        err.textContent = String((e2 as Error).message ?? e2);
      });
  });
  return () => panel.classList.remove("themed", type);
}

export function renderScreen(r: Route, ctx: Ctx): (() => void) | void {
  switch (r.kind) {
    case "types":
      return typesScreen(ctx);
    case "settings":
      return settingsScreen(r.type, ctx);
    default:
      return titleScreen(ctx);
  }
}

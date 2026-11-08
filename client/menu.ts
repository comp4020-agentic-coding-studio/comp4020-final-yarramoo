// The main menu: a pixel-art, hash-routed flow (title, New game types, world settings, share, Join game) over the live
// backdrop. Routes are pure (client/menu/router.ts); screens live in client/menu/screens.ts; the poller and death-log
// helpers are in client/menu/live.ts. API calls and storage are exactly the old menu's (D-184 backdrop unchanged).
import "./menu.css";
import { makeMusicButton, setMood, startMusicOnGesture } from "./music.ts";
import { unlock } from "./sfx.ts";
import { startMenuPreview } from "./menu-preview.ts";
import { NAME_KEY, TOKEN_KEY, store } from "./storage.ts";
import { formatRoute, parentRoute, parseRoute, type Route } from "./menu/router.ts";
import { renderScreen, type Ctx } from "./menu/screens.ts";

/** The first Join or Create opens this if `sand.name` isn't set yet; a returning visitor skips it entirely
 * ("the name comes at the moment of joining, not on arrival"). Registers and stores the token too, so the room page the
 * visitor lands on next finds a valid token and never shows its own name dialog again. */
function ensureName(root: HTMLElement): Promise<void> {
  if (store.get(NAME_KEY) && /^[0-9a-f]{64}$/.test(store.get(TOKEN_KEY))) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "mn-sheet-bg";
    const sheet = document.createElement("form");
    sheet.className = "mn-panel mn-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Pick a name");
    sheet.innerHTML = `
      <h2 class="mn-h">Pick a name</h2>
      <p class="mn-fine">Other players will see it. It stays in this browser.</p>
      <input class="mn-input" id="menuNameInput" maxlength="24" placeholder="Your name" aria-label="Your name" autocomplete="off" />
      <p class="mn-err" role="alert" hidden></p>
      <div class="mn-row">
        <button type="button" class="mn-btn ghost" data-act="cancel">Cancel</button>
        <button type="submit" class="mn-btn moss">Go</button>
      </div>
    `;
    backdrop.append(sheet);
    root.append(backdrop);
    const input = sheet.querySelector("#menuNameInput") as HTMLInputElement;
    const err = sheet.querySelector(".mn-err") as HTMLParagraphElement;
    input.focus();
    const close = () => {
      backdrop.remove();
      removeEventListener("keydown", onKey, true);
    };
    const cancel = () => {
      close();
      reject(new Error("cancelled"));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      }
    };
    addEventListener("keydown", onKey, true);
    sheet.querySelector('[data-act="cancel"]')!.addEventListener("click", cancel);
    sheet.addEventListener("submit", (e) => {
      e.preventDefault();
      const btn = sheet.querySelector('button[type="submit"]') as HTMLButtonElement;
      btn.disabled = true;
      fetch("/api/players", { method: "POST", body: JSON.stringify({ display_name: input.value }) })
        .then(async (r) => {
          if (!r.ok) throw new Error(r.status === 429 ? "The server is busy; try again in a minute." : `registration failed (${r.status})`);
          const j = (await r.json()) as { token: string; display_name: string };
          store.set(TOKEN_KEY, j.token);
          store.set(NAME_KEY, j.display_name);
          close();
          resolve();
        })
        .catch((e2) => {
          btn.disabled = false;
          err.hidden = false;
          err.textContent = String(e2.message ?? e2);
        });
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cancel();
    });
  });
}

export function startMenu(root: HTMLElement): void {
  root.classList.add("mn");
  root.innerHTML = `
    <div class="preview-bg" id="previewBg" aria-hidden="true"></div>
    <div class="mn-page">
      <div class="mn-strip">
        <button type="button" class="mn-btn ghost small" id="nameBtn"></button>
        <span class="mn-spacer"></span>
        <a class="mn-btn ghost small" href="/readme/">README</a>
      </div>
      <main class="mn-main"><div class="mn-panel mn-col" id="mnPanel"></div></main>
    </div>
  `;
  const panel = root.querySelector("#mnPanel") as HTMLDivElement;
  const nameBtn = root.querySelector("#nameBtn") as HTMLButtonElement;
  const refreshNameBtn = () => {
    const n = store.get(NAME_KEY);
    nameBtn.textContent = n ? `Playing as ${n}` : "Set a name";
  };
  refreshNameBtn();
  nameBtn.onclick = () => {
    store.del(TOKEN_KEY);
    store.del(NAME_KEY);
    ensureName(root).then(refreshNameBtn).catch(refreshNameBtn);
  };
  setMood("menu");
  startMusicOnGesture(unlock);
  (root.querySelector(".mn-spacer") as HTMLElement).after(makeMusicButton("mn-btn ghost small"));

  // Navigation depth, kept in history.state so Back only uses history.back() when the previous entry is ours.
  let pushedByUs = false;
  let depth = 0;
  const go = (r: Route) => {
    const h = formatRoute(r);
    if (h === location.hash || (h === "" && location.hash === "")) return render();
    pushedByUs = true;
    // An empty hash would leave a bare "#"; that parses as the title too.
    location.hash = h || "#";
  };
  const back = () => {
    if (depth > 0) history.back();
    else {
      const parent = parentRoute(parseRoute(location.hash));
      const h = formatRoute(parent);
      // Nothing of ours behind us (a shared link): replace rather than push, so Back never loops.
      history.replaceState({ mnDepth: 0 }, "", h || location.pathname + location.search);
      render();
    }
  };
  const ctx: Ctx = {
    root,
    panel,
    go,
    back,
    ensureName: () => ensureName(root),
    refreshName: refreshNameBtn,
  };

  let cleanup: (() => void) | null = null;
  let current: Route = { kind: "title" };
  function render() {
    cleanup?.();
    cleanup = null;
    current = parseRoute(location.hash);
    panel.replaceChildren();
    panel.dataset.screen = current.kind === "settings" ? `settings-${current.type}` : current.kind;
    cleanup = renderScreen(current, ctx) ?? null;
    const heading = panel.querySelector<HTMLElement>("[data-focus]");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    scrollTo(0, 0);
  }
  addEventListener("hashchange", () => {
    depth = pushedByUs ? depth + 1 : ((history.state as { mnDepth?: number } | null)?.mnDepth ?? 0);
    pushedByUs = false;
    history.replaceState({ mnDepth: depth }, "");
    render();
  });
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || current.kind === "title" || e.defaultPrevented) return;
    if (root.querySelector(".mn-sheet-bg")) return; // the name sheet handles its own Escape
    back();
  });
  depth = (history.state as { mnDepth?: number } | null)?.mnDepth ?? 0;
  render();
}

/** Start the backdrop after the menu has painted, so wasm never blocks first paint. */
export function startMenuBackdrop(root: HTMLElement): void {
  const host = root.querySelector("#previewBg") as HTMLElement | null;
  if (!host) return;
  requestAnimationFrame(() => setTimeout(() => startMenuPreview(host), 0));
}

// The main menu (R3, docs/plan-game-modes.md "The main menu"): mode cards, a public room list, a create
// sheet with a share bar, and the name sheet on first join/create. Live preview is deferred (see FUTURE.md
// and the worker report's "Architectural decisions for review" — not built in this slice, flagged rather than
// rushed, per the brief's own conditional wording for commit 6).
import { CONFIG_BYTES, CONFIG_FIELDS, CLASSIC_SANDBOX, CREATIVE, encodeConfig, SIZE_DIMS, type RoomConfig } from "../shared/room.ts";
import { HINT_SEEN_PREFIX, NAME_KEY, TOKEN_KEY, store } from "./storage.ts";

interface ModeDef {
  key: "survival" | "deathmatch" | "creative";
  title: string;
  rule: string;
  pvp: boolean;
  icon: string;
  cfg: RoomConfig;
}

const MODES: ModeDef[] = [
  {
    key: "survival",
    title: "Survival",
    rule: "Last one standing. PvP, one life.",
    pvp: true,
    icon: "/icons/survival.png",
    cfg: { terrain: 0, size: 1, avatars: 1, damage: 2, spells: 0, brushes: 0, death: 1, respawnSecs: 0, pickupRespawn: 0, round: 1, maxPlayers: 8 },
  },
  {
    key: "deathmatch",
    title: "Deathmatch",
    rule: "Fight, respawn. PvP.",
    pvp: true,
    icon: "/icons/deathmatch.png",
    cfg: { terrain: 0, size: 1, avatars: 1, damage: 2, spells: 0, brushes: 0, death: 0, respawnSecs: 3, pickupRespawn: 1, round: 0, maxPlayers: 8 },
  },
  {
    key: "creative",
    title: "Creative",
    rule: "Build together. No damage.",
    pvp: false,
    icon: "/icons/creative.png",
    // R4: CREATIVE from shared/room.ts (avatars: 1), not a hand-duplicated literal — this card previously had
    // avatars: 0, which would have created an avatar-less room indistinguishable from an upgraded sandbox and
    // never shown the brush/spell-bar toggle R4 built. Found during R4's review, fixed here.
    cfg: CREATIVE,
  },
];

interface PublicRoom {
  id: number;
  code: string;
  name: string;
  mode: string;
}

const isTouch = () => matchMedia("(pointer: coarse)").matches && innerWidth < 900;

/** The first Join or Create opens this if `sand.name` isn't set yet; a returning visitor skips it entirely
 * (plan: "the name comes at the moment of joining, not on arrival"). Registers and stores the token too, so
 * the room page the visitor lands on next finds a valid token and never shows its own name dialog again. */
async function ensureName(root: HTMLElement): Promise<void> {
  if (store.get(NAME_KEY) && /^[0-9a-f]{64}$/.test(store.get(TOKEN_KEY))) return;
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "sheet-backdrop";
    const sheet = document.createElement("form");
    sheet.className = "sheet";
    sheet.innerHTML = `
      <h2>Pick a name</h2>
      <p style="margin:0;color:var(--dim);font-size:13px">Other players will see it. It stays in this browser.</p>
      <input id="menuNameInput" maxlength="24" placeholder="Your name" aria-label="Your name" autocomplete="off" />
      <p class="err" hidden></p>
      <div class="actions"><button type="submit" class="btn">Go</button></div>
    `;
    backdrop.append(sheet);
    root.append(backdrop);
    const input = sheet.querySelector("#menuNameInput") as HTMLInputElement;
    const err = sheet.querySelector(".err") as HTMLParagraphElement;
    input.focus();
    sheet.addEventListener("submit", (e) => {
      e.preventDefault();
      const btn = sheet.querySelector("button") as HTMLButtonElement;
      btn.disabled = true;
      fetch("/api/players", { method: "POST", body: JSON.stringify({ display_name: input.value }) })
        .then(async (r) => {
          if (!r.ok) throw new Error(r.status === 429 ? "The server is busy; try again in a minute." : `registration failed (${r.status})`);
          const j = (await r.json()) as { token: string; display_name: string };
          store.set(TOKEN_KEY, j.token);
          store.set(NAME_KEY, j.display_name);
          backdrop.remove();
          resolve();
        })
        .catch((e2) => {
          btn.disabled = false;
          err.hidden = false;
          err.textContent = String(e2.message ?? e2);
        });
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        backdrop.remove();
        reject(new Error("cancelled"));
      }
    });
  });
}

export function startMenu(root: HTMLElement): void {
  root.innerHTML = `
    <div class="menu">
      <header class="menu-header">
        <h1>Falling Sand</h1>
        <div class="spacer"></div>
        <button type="button" class="linklike" id="nameBtn"></button>
        <a href="/readme/">README</a>
      </header>
      <section class="menu-hero">
        <div class="content">
          <h2>A shared world of sand, water, fire and spells.</h2>
          <p>Pick a mode below, or jump into a public room. No quick play: you always know what you're joining.</p>
          <button type="button" class="btn" id="heroCreate">Create a room</button>
        </div>
      </section>
      <div class="cards" id="cards"></div>
      <div class="room-list">
        <h2>Live rooms <select id="modeFilter"><option value="">all modes</option><option value="survival">Survival</option><option value="deathmatch">Deathmatch</option><option value="creative">Creative</option></select></h2>
        <div id="rooms"></div>
      </div>
      <div class="code-box">
        <form id="codeForm" style="display:flex;gap:8px;align-items:center">
          <label for="codeInput" style="color:var(--dim);font-size:13px">Have a code?</label>
          <input id="codeInput" maxlength="6" placeholder="ABCDEF" />
          <button type="submit" class="btn secondary small">Go</button>
        </form>
        <p class="err" id="codeErr" hidden></p>
      </div>
    </div>
    <div class="sheet-backdrop" id="createBackdrop" hidden></div>
  `;

  const nameBtn = root.querySelector("#nameBtn") as HTMLButtonElement;
  const refreshNameBtn = () => {
    const n = store.get(NAME_KEY);
    nameBtn.textContent = n ? n : "set a name";
  };
  refreshNameBtn();
  nameBtn.onclick = () => {
    store.del(TOKEN_KEY);
    store.del(NAME_KEY);
    ensureName(root).then(refreshNameBtn).catch(() => {});
  };

  // Mode cards + Sandbox.
  const cardsEl = root.querySelector("#cards") as HTMLDivElement;
  for (const mode of MODES) {
    const card = document.createElement("div");
    card.className = "card";
    const touchLocked = isTouch();
    card.innerHTML = `
      <h3><img src="${mode.icon}" alt="" onerror="this.style.display='none'" />${mode.title}</h3>
      <div class="rule">${mode.rule}</div>
      <span class="badge ${mode.pvp ? "pvp" : "safe"}">${mode.pvp ? "PvP" : "No damage"}</span>
      ${touchLocked ? `<div style="font-size:11px;color:var(--dim)">Desktop to play</div>` : ""}
      <div class="actions">
        <button type="button" class="btn secondary small" data-act="browse">Browse</button>
        <button type="button" class="btn small" data-act="new">New</button>
      </div>
    `;
    card.querySelector('[data-act="browse"]')!.addEventListener("click", () => {
      const sel = root.querySelector("#modeFilter") as HTMLSelectElement;
      sel.value = mode.key;
      sel.dispatchEvent(new Event("change"));
      root.querySelector(".room-list")?.scrollIntoView({ behavior: "smooth" });
    });
    card.querySelector('[data-act="new"]')!.addEventListener("click", () => openCreateSheet(mode));
    cardsEl.append(card);
  }
  const sandboxCard = document.createElement("div");
  sandboxCard.className = "card";
  sandboxCard.innerHTML = `
    <h3><img src="/icons/sandbox.png" alt="" onerror="this.style.display='none'" />Sandbox</h3>
    <div class="rule">Paint alone or together. Always on.</div>
    <span class="badge safe">No damage</span>
    <div class="actions"><button type="button" class="btn small" data-act="join">Join</button></div>
  `;
  sandboxCard.querySelector('[data-act="join"]')!.addEventListener("click", () => {
    ensureName(root).then(() => (location.href = "/sandbox")).catch(() => {});
  });
  cardsEl.append(sandboxCard);

  (root.querySelector("#heroCreate") as HTMLButtonElement).onclick = () => openCreateSheet(MODES[0]);

  // Room list: polled every 5s from GET /api/rooms (plan: id, code, name, mode, no player names, no live counts yet).
  const roomsEl = root.querySelector("#rooms") as HTMLDivElement;
  const filterEl = root.querySelector("#modeFilter") as HTMLSelectElement;
  let lastRooms: PublicRoom[] = [];
  function renderRooms() {
    const filter = filterEl.value;
    const rows = filter ? lastRooms.filter((r) => r.mode === filter) : lastRooms;
    roomsEl.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "room-empty";
      empty.textContent = "No rooms yet. Make one.";
      roomsEl.append(empty);
      return;
    }
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "room-row";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = r.name; // textContent only, never HTML (CLAUDE.md)
      const mode = document.createElement("span");
      mode.className = "mode";
      mode.textContent = r.mode;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn small";
      const avatarMode = r.mode === "survival" || r.mode === "deathmatch";
      btn.textContent = avatarMode && isTouch() ? "Watch" : "Join";
      btn.addEventListener("click", () => {
        ensureName(root).then(() => (location.href = `/r/${r.code}`)).catch(() => {});
      });
      row.append(nm, mode, btn);
      roomsEl.append(row);
    }
  }
  filterEl.addEventListener("change", renderRooms);
  async function pollRooms() {
    try {
      const r = await fetch("/api/rooms");
      const j = (await r.json()) as { rooms: PublicRoom[] };
      lastRooms = j.rooms ?? [];
      renderRooms();
    } catch {
      // A failed poll leaves the last-known list showing rather than clearing it.
    }
  }
  pollRooms();
  setInterval(pollRooms, 5000);

  // Code box: six characters, case-insensitive, goes to /r/<code>.
  const codeForm = root.querySelector("#codeForm") as HTMLFormElement;
  const codeErr = root.querySelector("#codeErr") as HTMLParagraphElement;
  codeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = root.querySelector("#codeInput") as HTMLInputElement;
    const code = input.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,6}$/.test(code)) {
      codeErr.hidden = false;
      codeErr.textContent = "That doesn't look like a room code.";
      return;
    }
    ensureName(root)
      .then(() => fetch(`/api/rooms/${code}`))
      .then((r) => {
        if (!r.ok) throw new Error("No room has that code.");
        location.href = `/r/${code}`;
      })
      .catch((err) => {
        codeErr.hidden = false;
        codeErr.textContent = String(err.message ?? err);
      });
  });

  // Create sheet (commit 3): room name, preset, terrain/size, public/unlisted, Advanced for every field.
  function openCreateSheet(preset: ModeDef) {
    const backdrop = root.querySelector("#createBackdrop") as HTMLDivElement;
    let cfg: RoomConfig = { ...preset.cfg };
    const render = () => {
      backdrop.innerHTML = "";
      const sheet = document.createElement("form");
      sheet.className = "sheet";
      const advRows = CONFIG_FIELDS.map((f) => {
        const v = cfg[f.key];
        return `<label>${f.key} (${f.min}-${f.max})<input data-field="${f.key}" type="number" min="${f.min}" max="${f.max}" value="${v}" /></label>`;
      }).join("");
      sheet.innerHTML = `
        <h2>Create a room</h2>
        <label>Room name<input id="roomName" maxlength="32" placeholder="${preset.title} room" /></label>
        <div class="row">
          <label>Preset
            <select id="presetSel">
              ${MODES.map((m) => `<option value="${m.key}" ${m.key === preset.key ? "selected" : ""}>${m.title}</option>`).join("")}
            </select>
          </label>
          <label>Size
            <select id="sizeSel">
              <option value="0" ${cfg.size === 0 ? "selected" : ""}>S</option>
              <option value="1" ${cfg.size === 1 ? "selected" : ""}>M</option>
              <option value="2" ${cfg.size === 2 ? "selected" : ""}>L</option>
            </select>
          </label>
        </div>
        <label class="toggle"><input type="checkbox" id="unlistedChk" /> Unlisted (link only)</label>
        <details>
          <summary>Advanced</summary>
          <div class="adv-grid">${advRows}</div>
        </details>
        <p class="err" hidden></p>
        <div class="actions">
          <button type="button" class="btn secondary" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn">Create</button>
        </div>
      `;
      backdrop.append(sheet);
      backdrop.hidden = false;
      const err = sheet.querySelector(".err") as HTMLParagraphElement;
      (sheet.querySelector("#cancelBtn") as HTMLButtonElement).onclick = () => (backdrop.hidden = true);
      (sheet.querySelector("#presetSel") as HTMLSelectElement).addEventListener("change", (e) => {
        const m = MODES.find((x) => x.key === (e.target as HTMLSelectElement).value)!;
        cfg = { ...m.cfg };
        render();
      });
      (sheet.querySelector("#sizeSel") as HTMLSelectElement).addEventListener("change", (e) => {
        cfg = { ...cfg, size: Number((e.target as HTMLSelectElement).value) };
      });
      sheet.querySelectorAll<HTMLInputElement>("[data-field]").forEach((inp) => {
        inp.addEventListener("change", () => {
          const key = inp.dataset.field as keyof RoomConfig;
          cfg = { ...cfg, [key]: Number(inp.value) };
        });
      });
      sheet.addEventListener("submit", (e) => {
        e.preventDefault();
        const btn = sheet.querySelector('button[type="submit"]') as HTMLButtonElement;
        btn.disabled = true;
        const name = (sheet.querySelector("#roomName") as HTMLInputElement).value.trim() || `${preset.title} room`;
        const visibility = (sheet.querySelector("#unlistedChk") as HTMLInputElement).checked ? "unlisted" : "public";
        const bytes = encodeConfig(cfg);
        if (bytes.length !== CONFIG_BYTES) {
          err.hidden = false;
          err.textContent = "Bad config.";
          btn.disabled = false;
          return;
        }
        const b64 = btoa(String.fromCharCode(...bytes));
        ensureName(root)
          .then(() =>
            fetch("/api/rooms", {
              method: "POST",
              body: JSON.stringify({ name, mode: preset.key, config: b64, visibility }),
            }),
          )
          .then(async (r) => {
            if (!r.ok) {
              const j = await r.json().catch(() => ({ error: "failed" }));
              throw new Error(j.error === "rate_limited" ? "Too many rooms today; try again tomorrow." : `Could not create the room (${j.error ?? r.status}).`);
            }
            const j = (await r.json()) as { code: string };
            backdrop.hidden = true;
            location.href = `/r/${j.code}`;
          })
          .catch((e2) => {
            btn.disabled = false;
            err.hidden = false;
            err.textContent = String(e2.message ?? e2);
          });
      });
    };
    render();
  }

  // Phone-first layout: the CSS handles the column breakpoint; nothing else is needed here.
  void CLASSIC_SANDBOX; // referenced for completeness of the room.ts/menu.ts config contract, no-op here
  void SIZE_DIMS;
}

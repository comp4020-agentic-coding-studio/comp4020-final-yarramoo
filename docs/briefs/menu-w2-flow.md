# Worker brief W2 (Sonnet): the pixel-art menu screens and routing

You are a Sonnet worker for the menu redesign (lead brief: `docs/briefs/menu-redesign.md`, read its "user's request"
and "design target" sections). Work only in `/tmp/wt-menu` (branch `menu-redesign`). Read `CLAUDE.md` there first.
**Do not dispatch subagents.** Do not push or merge; never touch
`/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`.

## Budget
Cap **$8**. Check spend at the start and every ~20 tool calls:
`curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
At start + $8 stop, commit what is green, write the report.

## Report as you go
`/tmp/wt-menu/docs/research/menu-w2-report.md`, updated after each commit (what landed, verification, spend). It has a
section **"Architectural decisions for review"** (choice, alternatives, why, later cost; take the reversible option
when unsure and flag it) and a list of `FUTURE.md` ideas (do not edit `FUTURE.md`).

## Files you may touch
- `client/menu.ts` (rewrite freely; keep the exports `startMenu(root)` and `startMenuBackdrop(root)` and their
  signatures: `client/main.ts` calls them), new modules under `client/menu/` (e.g. `router.ts`, `screens.ts`,
  `live.ts`), `client/menu.css` (add screen rules **below** the primitives; keep the tokens and primitives as they are
  unless a change is needed, and say why in the report), new `tests/net/menu-router.test.ts`.
- **Do not edit** `client/index.html`, `client/room.ts`, `client/slots.ts` (a parallel worker owns them), nor
  `client/menu-preview.ts` (the backdrop slice comes after you), nor anything in `server/`, `shared/`, `sim/`.
  The old `.menu`, `.cards`, `.sheet`... rules stay in `index.html` for now; your markup should use **new class
  names** (prefix `mn-`) so they do not collide. The lead moves the old rules out in one final commit.

## What exists (reuse, do not reinvent)
- `client/menu.ts`: `ensureName` (name sheet, POST `/api/players`, stores token/name), create (POST `/api/rooms` with
  `{name, mode, config: base64(encodeConfig(cfg)), visibility}` then `location.href = /r/<code>`), the room list poll
  (`GET /api/rooms`, `{rooms:[{id,code,name,mode,players}]}`, already busiest first), the code box
  (`GET /api/rooms/<code>` then `/r/<code>`), music (`setMood("menu")`, `startMusicOnGesture(unlock)`,
  `makeMusicButton`). Keep every one of these behaviours and API calls unchanged.
- `client/menu.css` (the lead's design contract): `.mn` root (put it on the menu container), tokens `--mn-*`,
  `.mn-panel`, `.mn-btn` with slab variants `lava` / `water` / `moss` / `ghost` / `small`. Font: Pixelify Sans, its
  pixel grid is 1/11 em, so **use font sizes 11, 22, 33, 44 px only** (body copy 11 px is small: use 22 px for
  buttons and headings, 11 px for labels and fine print, and test readability in the screenshots).
- Logo: `/logo/simulta-wordmark.png`, 83x22. Show it with `image-rendering: pixelated` at an **integer** scale:
  pick the largest of 3..8 that fits ~80% of the viewport width (set width/height in px from JS or with a few media
  queries; never a fractional scale). `alt="Simulta"`.
- Icons: `/icons/{survival,deathmatch,sandbox}.png` (256x256 photos-ish art; show them small, 44 or 88 px, pixelated).
- `GET /api/live` (being built by W1 right now; code against this exact shape):
  `{ players: number, rooms: number, deaths: { victim: string, killer: string|null, self: boolean, cause: number, bag: boolean, mode: string, at: number }[] }`.
  Phrase each death with `formatDeath` from `client/toasts.ts`: build a `DeathInfo` with victim id 1, killer id 2 (or
  1 when `self`, 0 when `killer` is null), `cause`, `bagDropped: bag`, and a `nameOf` mapping 1 -> victim, 2 -> killer.
  If the endpoint 404s (W1 not merged yet in your tree), hide the stat and the log silently.

## The screens (the lead's design; refine what looks wrong in your screenshots and say what you changed)
All screens share: the live backdrop behind (`#previewBg`, keep that element and `startMenuBackdrop`), a slim top
strip (name chip button "Playing as <name>" / "Set a name", music button, README link; 11 px), and one centred
`.mn-panel` column (max ~560 px wide, 16 px side gutter on phones, no horizontal scroll at 390 px).
1. **Title** (`/`): the big wordmark; a one-line tagline (22 px: "A shared world of sand, water, fire and spells.");
   two big buttons stacked or side by side: **New game** (sand slab) and **Join game** (water slab); under them a
   **players live** line ("3 players live in 2 rooms", or "Nobody's playing right now. Start something." when 0) with
   a small blinking pixel dot; and the **death log**: up to 5 lines, newest on top, older lines fading in opacity,
   each with a relative time ("12s", "4m"). New deaths slide in. `aria-live="polite"` on the log container. Poll
   `/api/live` every 5 s, **paused while `document.hidden`**, and immediately on becoming visible.
2. **New game: choose a type** (`#new`): three thematic cards (real `<button>`s): **Survival** (moss: "Descend
   together. One life. Beat the boss."; co-op badge), **Deathmatch** (lava: "Fight and respawn. PvP."; PvP badge),
   **Sandbox** ("Paint the shared world. Always on." goes straight to `/sandbox` via `ensureName`, no settings).
   On a phone (`(pointer: coarse)` and narrow), Survival/Deathmatch keep the existing "Desktop to play" note.
3. **World settings** (`#new/survival`, `#new/deathmatch`): themed per type: Survival with a "descent" motif (a
   dark gradient that deepens downward, moss accents, a depth gauge drawn in CSS pixels along the panel's edge is a
   nice touch), Deathmatch with an "arena" motif (lava accents, crossed-swords or a striped pixel border). Controls:
   - Room name (text, maxlength 32, placeholder "<Type> room").
   - **World size**: three big radio-style buttons S / M / L with a plain line each, from `SIZE_DIMS`
     (`shared/room.ts`): S "Small, 512 x 512: a quick round", M "Medium, 1024 x 768: the usual", L "Large, 2048 x
     1536: a long expedition". Defaults: the preset's `size`.
   - Mode options that deserve a visible control: Deathmatch: **respawn time** (`respawnSecs`, 1-10 s, a stepper),
     **max players** (2-8). Survival: **max players** (2-8). Everything else stays under an **Advanced**
     `<details>` with every `CONFIG_FIELDS` entry as now (number inputs), so nothing is lost.
   - **Public / Private (link only)**: a two-way segmented control (two `<button aria-pressed>` or radio inputs
     styled as slabs), default Public, with one line under it: public "Listed in Join game for anyone." / private
     "Not listed. Only people with the link can join." Maps to `visibility: "public" | "unlisted"`.
   - **Create** (big slab in the type's colour) and **Back**.
4. **Share** (`#share/<CODE>`): after creating a **private** room, do not go straight in: show the room's link
   (`${location.origin}/r/<CODE>`) in a big read-only field with a **Copy link** button (`navigator.clipboard`, falls
   back to selecting the text; "Copied!" for 1.5 s) and the code in 33 px letters, and an **Enter room** button.
   Public rooms go straight in as now. The share screen is linkable (reload shows it again; it only needs the code).
5. **Join game** (`#join`): the live public room list (keep the 5 s poll and busiest-first order; poll only while this
   screen is shown and the tab is visible), a mode filter as three small toggle buttons (All / Survival /
   Deathmatch), each row: room name (textContent only), mode badge, "N playing", a **Join** (or "Watch" on phones for
   avatar modes) button; an empty state "No public rooms yet." with a **New game** button; and the **"Have a code?"**
   box (6 chars, uppercase, same validation and error text as now).

## Routing
Hash routes, so every step is linkable and the browser Back button walks back through steps without leaving the site:
`""` title, `#new`, `#new/survival`, `#new/deathmatch`, `#join`, `#share/ABC123`. A pure function
`parseRoute(hash: string): Route` (in `client/menu/router.ts`, no DOM) returns a discriminated union; unknown hashes
map to the title. Navigation with `location.hash = ...` (so it pushes history), rendering on `hashchange`. Every
screen has a visible **Back** button that goes one step up the tree (settings -> types -> title; join -> title; share
-> title), using `history.back()` only when the previous entry is ours, else setting the parent hash. When a screen
renders, move focus to its heading (`tabindex="-1"`) so keyboard and screen-reader users land in the right place.
Escape on any non-title screen = Back.

## Commit checklist (one commit each; each message ends with
`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`)
1. [ ] `client/menu/router.ts` + `tests/net/menu-router.test.ts` (pure parse/format tests: every route, unknown
   hashes, codes upper-cased, a bad code -> title). **Shown red first** (write the test, run it against a stub that
   returns the title for everything, paste the failing summary into the report), then green.
2. [ ] Title screen + top strip + players live + death log (`client/menu/live.ts` for the poller; a pure
   `relTime(ms)` helper with a test in the same test file).
3. [ ] Types screen + settings screens (both themes) + create flow (public goes in, private goes to share).
4. [ ] Share screen + Join screen.
5. [ ] Phone/landscape fixes from your screenshots, report finalised.

## How to verify
- Types and tests before each commit, gated on the exit code (never `;`, never `| grep`):
  `cd /tmp/wt-menu && pnpm typecheck > /tmp/menu-w2-tsc.log 2>&1 && pnpm vitest run --config vitest.net.config.ts tests/net/menu-router.test.ts tests/net/menu-room.test.ts tests/net/imports.test.ts > /tmp/menu-w2-net.log 2>&1 && git add <files by name> && git commit -q -F /tmp/menu-w2-msg.txt; echo "exit $?"`
- **Open it and look.** The wasm is built in this worktree. Start a check server and vite on the brief's ports
  (never 8080 or 5173):
  `mkdir -p /tmp/menu-data && (cd /tmp/wt-menu && PORT=8091 DATA_DIR=/tmp/menu-data nohup node server/main.ts > /tmp/menu-server.log 2>&1 &)`
  and `(cd /tmp/wt-menu && nohup npx vite --config client/vite.config.ts --port 5191 --strictPort > /tmp/menu-vite.log 2>&1 &)`.
  Vite on 5191 has no API proxy: open the **node server** instead after `pnpm build:client:only > /tmp/menu-w2-build.log 2>&1`
  (it rebuilds `dist/client` from the current wasm; then restart the 8091 server so its hash matches, see the
  `dev-server` skill) and browse `http://localhost:8091/`. Or use vite with `?server=localhost:8091` only if the
  menu honours it (it does not today; do not add it).
- agent-browser via `zsh -ic`, a named session (`--session menuw2`): `set viewport 1280 800`, then 390 844, then 844
  390. Screenshot every screen to `/tmp/wt-menu/docs/research/shots/menu-w2-<screen>-<w>.png`, **Read every png**,
  fix what looks wrong (overflow, unreadable text over the backdrop, misaligned slabs, fractional logo scale). Commit
  the final screenshots (they are evidence; keep them under ~150 KB each: `sips -Z 1280` if needed).
- Keyboard once: Tab through the title and settings screens; focus ring visible; Enter activates; Escape goes back.
- Create one public and one private room on 8091 and check the private one shows the share screen with a working
  copy button and the public one goes straight to `/r/<code>`.
- At the end: kill the server and vite you started **by literal PID** (`lsof -ti tcp:8091 -sTCP:LISTEN`,
  `lsof -ti tcp:5191 -sTCP:LISTEN`), close your agent-browser session. Leave `/tmp/menu-data` (the lead reuses it).

## Rules
- Player-facing names are the plain chosen name; never render `name#id`. Room names and death-log names go in with
  `textContent`, never `innerHTML`.
- Buttons are real `<button>`s; focus visible; text contrast readable over the moving backdrop (the panels are
  near-opaque on purpose; do not add `backdrop-filter` blur, it is costly on phones).
- `prefers-reduced-motion`: no slide-in, no blinking dot.
- Every `rm` names a literal absolute path.

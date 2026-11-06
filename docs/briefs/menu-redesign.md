# Brief MENU: a redesigned, pixel-art main menu (Opus lead, Sonnet/Haiku workers)

Written 6 Nov by the session model from the user's request. You are the **Opus lead**: you plan, slice, brief
workers, review and merge their work, and own the design. You may dispatch **Sonnet** workers (implementation) and
**Haiku** workers (mechanical jobs), **one at a time**, each with its own brief written to `docs/briefs/menu-*.md`.

## The user's request (6 Nov), verbatim in substance
- The menu should have graphic design: **pixelated**.
- Flow: players see a **cool "Simulta" logo**. Then **two buttons: New game, Join game.**
- **New game** gates through to the **game types**, then a **thematic game settings screen** where they configure a
  new world and whether it is **public or private (joinable with a link)**.
- A **"players live" stat**, and maybe a **rolling log of player deaths**.
- A **cool pixelated font**.
- The **background simulation** becomes a cool **landscape with lots of little element interactions**, plus **mobs
  jumping and flying around**.
- "Feel free to iterate on any ideas you have while developing."

## Budget and stopping (hard rules: nothing enforces these but you)
- Cap **$35 total** for you and every worker. Read spend at the start (note B0), after every worker returns, and every
  ~25 of your own tool calls:
  `curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
  Stop dispatching at B0 + $30; finish and report by B0 + $35. Put each worker's own cap in its brief (Sonnet
  slices ~$5-8, Haiku ~$1) and its own `/api/me` checks.
- At most **4 workers** in total, **one at a time** (the machine wrecks gates under parallel load; CLAUDE.md).
- Write `docs/research/menu-redesign-report.md` **as you go** (after each slice), so a run that dies leaves a record.

## Where
- `git worktree add /tmp/wt-menu -b menu-redesign multa`; you and every worker work there only. Workers may use
  sub-worktrees off `menu-redesign` if you want, but merge into `menu-redesign` yourself. **Never touch the main
  checkout** (`/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`), never push, never merge into `multa`: the
  session model reviews, gates and merges.
- **A parallel slice is running**: a Sonnet worker in `/tmp/wt-phone` (branch `phone-play`) is adding touch controls
  and a scrollable hotbar. It edits `client/room.ts`, `client/index.html` (hotbar/HUD CSS) and maybe
  `client/slots.ts`. **Do not edit those files** beyond what is unavoidable; put menu styles in a new
  `client/menu.css` (imported by `client/menu.ts`, Vite handles it) and move the existing `.menu`, `.cards`,
  `.sheet`, `.room-list`, `.code-box`, `.preview-bg` rules out of `index.html` only in **one small, final commit** so
  the merge conflict, if any, is one hunk.
- Ports: vite **5191**; a node server **8091** with `DATA_DIR=/tmp/menu-data`. Kill both by PID at the end.
  Build both wasms in the worktree before vite (`pnpm build:sim && pnpm build:sim:devpaint`).

## What exists (read these first)
- `client/menu.ts` (370 lines): `startMenu` renders the header, hero, mode cards, the live room list, the code box,
  and the create sheet (preset, size, "Unlisted (link only)", Advanced fields), `ensureName` (POST `/api/players`),
  create = POST `/api/rooms` then `location.href = /r/<code>`. `startMenuBackdrop` starts the backdrop after first paint.
- `client/menu-preview.ts` (158 lines): the backdrop (D-184, the user picked this "menu-local" variant): a private
  local sim in the game's own worker, fed **Paint inputs** by a scripted director (`sceneAt`: ledges, a water basin, a
  lava pocket, wood with fire; emitters), restarted every 80 s, reduced-motion and phone variants.
- `client/index.html`: tokens (`--bg`, `--panel`, `--accent`...) and all CSS; the menu CSS is around lines 160-200.
- Server: `GET /api/rooms` (public rooms with live player counts, `server/main.ts` ~830), `GET /api/rooms/:code`,
  `POST /api/rooms`, `POST /api/players`; `GET /api/summary` is the public dashboard summary (`server/dashboard.ts`
  ~195; aggregates only). Deaths resolve by majority claim in `w.onDeathResolved` (`server/main.ts` ~572).
- Icons: `client/public/icons/{logo,survival,deathmatch,sandbox}.png`. The `image-gen` skill can make more (pixel art).
- Tests: `tests/net/menu-room.test.ts`, `tests/net/menu-live-counts.test.ts`, `tests/net/music.test.ts` touch the
  menu; `spec/` (the `pnpm check` spec) fetches `/` and `/sandbox`.
- Skills: `run-tests`, `dev-server`, `dev-tools` in `.claude/skills/` (dev-tools covers routes, hooks, ids).

## Rules that bind this work (CLAUDE.md; break one only by asking)
- **Invariant 1/9**: the backdrop sim gets state **only** through inputs (`Paint` via pointer messages, as now).
  Mobs in the backdrop must be real sim enemies (see "Mobs" below), never drawn-on fakes that pretend to be sim
  state, and nothing read from the sim feeds back as input except the director's own script.
- **Players see only their plain chosen name**, never `name#id` (memory + CLAUDE.md). A public death log shows plain
  names only, and aggregates only: **no player id, no IP, no room code of an unlisted room.**
- **Every server-side action logs through `log.event`** with a name in `shared/events.ts`; no `console.*` in
  `server/`; anything a client can hit repeatedly is rate-limited or cheap and cached. **`server/` and `shared/`
  never import from `client/`** (`tests/net/imports.test.ts`).
- **An input must not cost unbounded work**: the director's paints stay within the sim's clamps.
- No external font or script hosts at runtime unless they're already allowed: **self-host the font** (a pixel font
  with an OFL or similar licence, committed under `client/public/fonts/`, licence file alongside; cite it in the
  report). No Google Fonts link.
- Accessibility: buttons are real `<button>`s, keyboard-navigable, focus visible; text contrast stays readable over
  the moving backdrop (a scrim or panel); `prefers-reduced-motion` keeps a still or slow backdrop (it exists now:
  keep it).

## The design target (yours to refine; iterate on what you see)
1. **Title screen**: the Simulta logo (pixel art, big, crisp: `image-rendering: pixelated`, integer scaling), over
   the live backdrop. Two big pixel-styled buttons: **New game** and **Join game**. A small **"N players live"**
   stat and a **rolling death log** ("Ana was buried by the Sand Colossus", ~5 lines, fading). The name chip and
   README link stay, smaller.
2. **New game** → **choose a type**: Survival (co-op descent, one life, defeat the boss) and Deathmatch (PvP), plus
   Sandbox if it fits (Sandbox today is one shared world joined directly: keep a "Sandbox" entry that just goes to
   `/sandbox`, unless you find a reason not to). Thematic cards with the existing icons or new pixel art.
3. **World settings screen**, themed per type (e.g. Survival: a descent/depth motif; Deathmatch: an arena motif):
   room name, **world size** (S/M/L with a short plain-language description), the mode's useful options (respawn,
   damage, round, max players: decide which deserve a visible control and which stay under "Advanced"), and
   **Public / Private (link only)** as a clear two-way choice (maps to `visibility: "public" | "unlisted"`). After
   create, **private** rooms should show the share link prominently (copy button) before or on entering the room.
4. **Join game**: the live public room list (busiest first, as now, with mode filter) and the **"Have a code?"** box.
5. **Back** works at every step (and the browser back button: use `history.pushState`/`popstate` or hash routes so a
   step is linkable and Back doesn't leave the site).
6. **Backdrop**: a landscape (sky, a surface with hills, trees, water, a lava pool, sand dunes, a cave mouth), with
   **many small interactions** running (water meeting lava into rock/steam, fire spreading on wood and moss, sand
   pouring, gunpowder pops, rain, snow on a peak if the sky allows) and **mobs jumping and flying**. Keep it cheap: it
   runs on phones too (measure frame time at 4x CPU throttle like D-184 did; keep the phone variant lighter).

### Mobs in the backdrop (a decision for you; flag it)
Enemies are sim entities placed by world generation in Survival worlds, not by Paint. Options, in order of
reversibility: (a) run the backdrop on a **small generated Survival-preset world** (size S) with the director
painting the surface scene on top, so slimes, imps, wisps and frost sprites are real and move by the sim's own rules,
with the backdrop's local avatar absent (enemies only step near an active player: check `ENEMY_ACTIVE_W` and the
stepping rules; a local spectate-style camera may not wake them: measure); (b) a dev-only or menu-only sim input to
spawn an enemy: **this changes the sim ABI and needs the user's sign-off; do not do it without asking via the session
model**; (c) client-drawn sprites that are purely decorative and clearly not sim state. Prefer (a); if it can't work,
report why and choose (c) only as a last resort, labelled as decoration in the code. Record the choice in
"Architectural decisions for review".

### Server additions (small, reviewed)
- **Players live**: total connected non-spectator players across public rooms, from data the server already has.
  Either extend `GET /api/rooms` or add `GET /api/live` returning `{ players, rooms, deaths: [...] }`. Cache it for
  ~2 s server-side so a menu poll storm costs nothing; poll from the menu every ~5 s (stop when the tab is hidden).
- **Death log**: a ring buffer (~20) filled in `w.onDeathResolved` for **public** rooms only, holding
  `{ victim: plain name, killer: plain name | null, cause, mode, at }`. Phrase it client-side with
  `formatDeath` (`client/toasts.ts`), so the wording matches the in-game toast. Test it in `tests/net/` (shown red
  first): public deaths appear, unlisted rooms' deaths never do, names are plain, the buffer is capped.
- Log it: add the event name(s) to `shared/events.ts` if you add any server log line.

## Slices (suggested; re-slice if you see better)
1. **Design + assets** (you, or Haiku for fetching/converting): pick the font (self-hosted, licensed), the logo (the
   `image-gen` skill for a pixel-art "Simulta" wordmark, or hand-drawn pixel SVG/PNG: try both, pick the better,
   keep the other in the report), palette tokens in `client/menu.css`. Write a one-page design note in the report.
2. **Menu flow** (Sonnet): the screens and routing in `client/menu.ts` (split into modules if it grows:
   `client/menu/*.ts`), using the existing create/join API calls unchanged. Tests for any pure routing/state helper.
3. **Server: players live + death log** (Sonnet): the endpoint, the ring buffer, its net test, the menu's poller.
4. **Backdrop landscape + mobs** (Sonnet): `client/menu-preview.ts` (or `client/menu/backdrop.ts`), the mob
   approach you chose, perf measured on desktop and 4x throttled, reduced-motion still frame kept.
Each worker brief: names its files, the contract it must reuse, a commit checklist (one commit per item), how to
verify, the dollar cap and `/api/me` checks, "Architectural decisions for review", and "write your report to a file
as you go". Remind workers: **show every new test red first**; `pnpm check` defaults to :8080 (the user's server):
run it as `APP_URL=http://localhost:8091 pnpm check` against your own server on the fresh build.

## Verify (you, before handing back)
- `pnpm typecheck`, `pnpm test:net`, and `APP_URL=http://localhost:8091 pnpm check` against your own server built
  from the branch. No change in `sim/` is expected; if one becomes necessary, stop and report instead.
- **Open it and look** (agent-browser, `zsh -ic`, viewport 1280x800, then 390x844 and 844x390): screenshot every
  screen (title, New game types, each settings screen, Join, a created private room's share link), Read every png,
  iterate on what looks wrong. Two sessions: create a public Survival room in one, see "players live" change in the
  other's menu; kill a player (or simulate a resolved death in a net test) and see the death log update.
- Check reduced motion (`agent-browser` media emulation if available) and keyboard-only navigation once.

## Hand back
- `docs/research/menu-redesign-report.md`: what was built, the design note, screenshots under
  `docs/research/shots/menu-*.png`, each worker's spend and outcome, gate/test results with log paths,
  **Architectural decisions for review** (mobs approach, endpoint shape, routing, font/licence, file split),
  ideas for `FUTURE.md` (don't add them yourself; list them).
- A D-row draft for `docs/DECISIONS.md` and an `engineering-decisions.md` entry draft in the report (the session
  model adds them).
- Branch `menu-redesign` committed, not pushed. Every commit ends with the right `Co-Authored-By` line for the model
  that wrote it (yours: `Claude Opus 5.5 <noreply@anthropic.com>`; Sonnet: `Claude Sonnet 5.5 <noreply@anthropic.com>`;
  Haiku: `Claude Haiku 5.5 <noreply@anthropic.com>`).
- Kill every vite/node you or a worker started (`pgrep -fl "vite.js|server/main"`; never the user's :8080, PID in
  `HANDOVER.md`), close every agent-browser session, remove temp dirs by literal path.

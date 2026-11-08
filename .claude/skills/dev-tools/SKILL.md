---
name: dev-tools
description: Simulta's in-browser dev tools: dev routes and URL flags (?world=game&avatar=1, ?cfg=survival, ?seed, ?sky, ?debug=1, ?activebox=1), console hooks (__devPaint, __devGoto, __devGotoEnemy, __devBossHp, __devMe, __activeBox), material, spell and enemy ids, and the generator preview. Use when you need to see a spell, enemy, boss phase, biome or the active box in a browser, reproduce a sim bug by eye, take screenshots, or when asked "how do I get to the boss", "paint lava from the console", "show the chunks", "preview a seed".
---

# Dev tools in the browser

Line numbers are from 6 Nov (`multa` 19b5b4f); grep the symbol if they drift. Everything here is client-side. A hook
either sends a worker message that moves the local controller (the avatar then reports it through the normal `Pos`
input) or only draws. **No hook is a new input kind** (invariants 1, 9), except `__devPaint`, which sends an ordinary
`Paint` input (see the table).

## Two places to run it

- **Vite dev server, `pnpm dev:client` on :5173** (`client/vite.config.ts:43`, strict port). Builds `sim.wasm` and
  `sim-dev.wasm` (cargo feature `dev_paint`, `package.json` `build:sim:devpaint`), and serves both. Not for the user's
  :8080. Never rebuild under a running gate (see `run-tests`).
- **A real room on the node server** (`dev-server` skill; own port and data dir). Production build: `import.meta.env.DEV`
  is false, so every `DEV`-only item below is absent.

## URL flags (`client/room.ts`)

| Flag | Works on | Effect |
|---|---|---|
| `/game?world=game` | vite only (`room.ts:151`, `import.meta.env.DEV`) | A local single-player sim of the game world in the worker: no network, loads `sim-dev.wasm`, so Paint works in a game world (D-056). |
| `&avatar=1` | vite, with `world=game` (`:153`) | Joins player 1 locally: it can steer, cast, die and pick up. Without it you only look around, and `__devPaint/__devGoto/__devBossHp` do nothing. |
| `&cfg=survival` | vite, `world=game` (`:136`, `:1238`) | Local sim runs the Survival preset (auto-ready at join, `worker.ts:1183`). Default is the old fixed game world. |
| `&seed=N` | vite, `world=game` (`:1238`) | Generator seed, default `"1"`. |
| `&sky=night\|day\|dawn\|rain\|aurora` | vite only (`:1255`; `sky.ts:3`) | Overrides the seed's sky. Unknown names fall back to the seed's. |
| `&spectate=1` | any avatar room (`:143`) | Watch, don't play (phones get it automatically). |
| `?debug=1` or `?stats` | any build (`:60`, `:1218`) | The status line adds players, tick, step p50/p95 and chunks run, and `window.__stats` is set. |
| `?activebox=1` | any build (`:1341`) | Same as `__activeBox(true)` on load. |
| `?server=host:port` | any build (`:1235`) | Point a vite page at a separate node server (HTTP and WS). |

`/sandbox` and `/r/<code>` are the real, networked routes; they ignore `world`, `avatar`, `cfg`, `seed`, `sky`
(sky is still read but `import.meta.env.DEV` gates it).

## Console hooks (`client/room.ts:1310-1345`)

Run them with `eval` in agent-browser (below) or the page console.

| Hook | What it does | Gate | Input? |
|---|---|---|---|
| `__devPaint(x, y, mat, r)` | A pointer down and up at world cell (x, y) with material `mat`, radius `r`: one `Paint` stroke. | `devAvatar` only (`:1315`): vite + `world=game&avatar=1`. A no-op everywhere else. On a real sandbox, use the brush. | Yes, a real `Paint` through `push_input` (`worker.ts:255`). Local sim only, so no shared state. Clamped by the sim (radius, stroke length). |
| `__devGoto(spell)` | Walks the local avatar onto the nearest active pickup of that spell id (`worker.ts:1207-1221`). | vite + `devAvatar`; or a real room whose server runs with `SIMULTA_DEV_TELEPORT=1` (see below). | Moves the controller; the jump goes out as a `Pos`. |
| `__devGotoEnemy(kind?, dist?)` | Teleports next to the nearest enemy (of `kind`, else any). Stands `dist` cells away (default 12; the boss 14 to its right, signed offset for the boss). | Same as `__devGoto`. | Same. |
| `__devBossHp(hp)` | Patches the boss's hp (1-65535) in a snapshot and `restore`s it, to see each phase (`worker.ts:1245`). | vite + `devAvatar` + local sim only. | Not an input, but it **writes sim state outside `push_input`** (snapshot patch). Local only; never in a real room. |
| `__devMe()` | The local player's entry from the last players message, or `null`. | vite only (`:1336`). | Read-only. |
| `__activeBox(on=true)` | Draws a chunk grid in the active area, tints frozen chunks blue, and outlines the active box (`worker.ts:752`). | Every build (`:1342`). | Drawing only, from entity positions. |
| `__setCam(x, y, overview)` | Sets the camera. `__setSleep(on)` turns chunk sleeping off or on. | Every build; `__setSleep` only acts on a local sim (`worker.ts:1270`). | Camera only. Sleeping is invisible (invariant 8), so `__setSleep(false)` is for comparing. |

`SIMULTA_DEV_TELEPORT=1 node server/main.ts` (`server/devteleport.ts`) makes `GET /api/rooms/:code` return
`devTeleport: true`; the client then installs remote versions of `__devGoto` and `__devGotoEnemy` (`room.ts:1319`) and
exposes `window.__boss`. **Only in a production-built client** (`pnpm build:client`, served by the node server): on vite
the `import.meta.env.DEV` block (`room.ts:1325`) overwrites both with the local versions, which need `devAvatar` and
drop `dist`, so `?server=` from vite gets no-op hooks. The server accepts any `Pos` jump and logs `dev.teleport` (`server/world.ts:789`). It is
refused when `NODE_ENV=production` or `FLY_APP_NAME` is set. `__devBossHp` and `__devPaint` never work in a real room.

## Ids

- **Materials** (`shared/names.ts`, `sim/src/materials.rs`): 0 Erase, 1 Bedrock (not paintable), 2 Rock, 3 Dirt, 4 Sand,
  5 Water, 6 Wood, 7 Seed, 8 Stem, 9 Flower, 10 Fire, 11 Smoke, 12 Steam, 13 Gunpowder, 14 Lava, 15 Oil, 16 Acid,
  17 Gas, 18 Ice, 19 Glass, 20 Coal, 21 Pebbles, 22 Brick, 23 Moss, 24 Mushroom. Not paintable: 1, 8, 9, 21 (`isPaintable`).
- **Spells** (`SPELL_NAMES`, also the `__devGoto` argument): 0 Push, 1 Blast, 2 Water, 3 Rose, 4 Fire, 5 Bomb, 6 Dig,
  7 Acid Flask, 8 Oil Flask, 9 Wall, 10 Lava Flask, 11 Black Hole.
- **Enemy kinds** (`sim/src/tuning.rs:168-172`, the `__devGotoEnemy` argument): 0 Slime, 1 Imp, 2 Acid Slime, 3 Worm,
  4 Boss. Internally `devgoto` encodes "enemy kind k" as spell `-2 - k` and "any enemy" as `-1` (`worker.ts:1214`).

## Generator preview

`http://localhost:5173/gen-preview.html?seed=1&terrain=0&size=2` (vite only; never in `dist/`, pinned by
`tests/net/gen-preview-dev-only.test.ts`). `terrain` 0 Caves, 1 Solid box, 2 Empty box; `size` 0 S 512x512, 1 M
1024x768, 2 L 2048x1536 (`gen-preview.html:21-31`, `gen-preview.ts:156-159`). Draws the whole generated world and a text
readout. Controls: the Seed box, the two selects, Generate, and -1 / +1 to step the seed. There are no keyboard shortcuts.
It runs its own `sim.wasm`, not a room.

## Driving it from the agent

Same pattern as the `dev-server` skill ("Look at it yourself"): `zsh -ic`, a named `--session`, viewport 1280x800 first.

```bash
zsh -ic 'agent-browser --session dt set viewport 1280 800; agent-browser --session dt open "http://localhost:5173/game?world=game&avatar=1&cfg=survival&seed=7&sky=day"; sleep 3'
zsh -ic 'agent-browser --session dt eval "__devPaint(1000,700,14,8); __devGotoEnemy(4)"'
zsh -ic 'agent-browser --session dt eval "JSON.stringify(__devMe())"'
zsh -ic 'agent-browser --session dt screenshot /tmp/dt.png'   # then Read the png and look at it
zsh -ic 'agent-browser --session dt close'
```

- Use your own port and data dir for any node server, never the user's :8080 (`dev-server` skill). Check
  `pgrep -fl "vite.js|server/main"` afterwards and close every session.
- Two sessions (`--session a`, `--session b`) on a real room show sync bugs a single tab hides (CLAUDE.md "Open it and look").

## Not available

- **There is no hitbox overlay**, for the player or any entity. `client/hazard.ts` mirrors the player's 5x10 hitbox
  (`HITBOX_W`, `HITBOX_H`, from `Player::hitbox_cells`, `sim/src/entities.rs`) only to decide the lava sizzle; nothing
  draws it. Do not go looking. Inferring a hitbox means reading `entities()` x/y (1/16 cell) and the sim's constants.
- No hook sets health, gives spells, spawns enemies or sets the tick. `__devBossHp` is the only state patch.

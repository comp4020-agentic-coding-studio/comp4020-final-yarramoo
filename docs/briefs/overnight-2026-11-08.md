# Overnight 8-9 Nov: improvement tracks (shared rules for every lead)

Written 8 Nov by the session model. The user's instructions: "dispatch some agents to work overnight looking into
improvements we can make to the game"; **$170 for the night** (raised from $120 when tracks D and E were added; week
spend was $196 of a $500 weekly budget, so the whole run stops starting new work at **$366**); improvements are **built, gated, reviewed and merged to `multa`**
(never `main`: it deploys, the user decides in the morning). Final submission is **Mon 9 Nov 12:00**: a smaller,
finished, correct change beats a bigger one; anything risky becomes a report with a ready brief, not a merge.

Each track is one **Opus lead** that briefs and reviews **Sonnet/Haiku** workers. Tracks run **one at a time** (the
session model starts the next when one hands back), so cargo gates never collide.

## Rules for every lead (on top of `CLAUDE.md`, which binds you fully)
- **Your track's cap is in your dispatch prompt.** Read `/api/me` at the start (B0), after every worker and every ~20
  of your own tool calls; stop dispatching at B0 + 80% of your cap and finish by B0 + your cap. **If the week reads
  $366 or more, stop at once**, commit what you have to your branch and report.
  `curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`
- **At most 3 workers per track, one at a time.** Workers never dispatch. Each worker brief lives in
  `docs/briefs/<track>-*.md` on your branch with its own cap, the files it may touch, a commit checklist, how to
  verify, and "Architectural decisions for review"; it writes its report to a file as it goes.
- **Work in your own worktree** (`git worktree add /tmp/wt-<track> -b <track> multa`). Never touch the main checkout or
  the user's :8080 server (PID in `HANDOVER.md`); never push; never merge into `multa` (the session model gates and
  merges). Ports and data dirs per track are in your prompt; kill everything you start; remove temp dirs by literal path.
- **One heavy job on the machine at a time**: `pgrep -fl "cargo test|vitest|test:determinism|tests/soak"` and
  `docker ps` before any gate or bench.
- **Every new test shown red first.** Grep constants, not just functions, when adding a kind, material or id. Run the
  full `run-tests` gate in your worktree if `sim/`, `shared/` or the input path changed; `pnpm typecheck && pnpm
  test:net` otherwise; `APP_URL=http://localhost:<your port> pnpm check` against your own server (never the default).
- **A cold Sonnet review** (read-only, its findings written to `docs/research/review-<track>.md`) of anything touching
  `sim/`, the protocol, the snapshot, or the server's trust path; check its claims in the code before acting.
- **Open it and look**: screenshots you Read for every visible change (dev-tools skill); two browsers in a real room for
  anything multiplayer.
- **Record**: `docs/research/<track>-report.md` written as you go: what was built and cut, per-worker spend and total,
  gate results with log paths, screenshots, **Architectural decisions for review**, D-row drafts, an engineering-
  decisions entry draft if it's a big decision, FUTURE.md ideas (listed, not added).
- Commits end with the writing model's `Co-Authored-By` line: Opus `Claude Opus 5.5 <noreply@anthropic.com>`, Sonnet
  `Claude Sonnet 5.5 <noreply@anthropic.com>`, Haiku `Claude Haiku 5.5 <noreply@anthropic.com>`.

## Track A, quality (first): find and fix what's broken before submission
**Cap $45. Branch `quality`, worktree `/tmp/wt-quality`, ports 8084 (servers) / 5184 (vite), data `/tmp/quality-*`.**
1. **Playtest like a user** (agent-browser, two sessions in a real Survival room and a Deathmatch room on your server,
   plus the menu, the sandbox and a phone viewport): the full flow from the menu to a round's end. Write every bug you
   find into the report with a screenshot, before fixing anything; rank them.
2. **Known open items** (check each still reproduces):
   - `docs/research/n1-throttled-regression.md`: the 4x-throttled N1 client stopped keeping up at `51524fa` (hotbar
     CSS); its "next step" says how to find which property matters (`pnpm soak:n1`, ~10 min; `DURATION_S=180` for a
     quick check). Find the mechanism; fix it without losing the one-row scrolling hotbar the user likes.
   - The user's feedback: "there is still the occasional issue where spells cannot be picked up" (pickups reach was
     widened on 5 Nov: `PICKUP_REACH_BELOW`; check whether it still happens and where).
   - Show the boss on the room card / lobby ("Boss: Sand Colossus") since it's chosen per seed (FUTURE.md).
3. Fix the top items you can finish and verify tonight; leave the rest as ranked findings with briefs.

## Track B, content: the user's feedback, what's still undone
**Cap $50. Branch `content`, worktree `/tmp/wt-content`, ports 8083 / 5183, data `/tmp/content-*`.**
Read the user's feedback list in `HANDOVER.md`-adjacent notes: `docs/playtest-*.md`, FUTURE.md (sections "A livelier
surface", "Biome follow-ups", "World life follow-ups", "Sandbox rooms"), and pick what gives the most to the showcase
for the budget. Candidates (yours to rank, cut or replace): **rabbits** as a passive sim kind (brief ready on the
`world-life` history: `git show a5d3e73^2:docs/briefs/life-w2-rabbits.md`; review its id, the `MAX_ENEMIES` raise to
80 and lobby stepping before building); **sandbox rooms** (the same create/share interface as game rooms, public or
private, with an expiry within 24 h); **a surface lake and hills** (`docs/briefs/biomes-surface.md`); **per-biome cave
walls** from the generator (D-211 captures the background at generation); **more frost sprites per ice cave**.
**The user added (8 Nov): more structures, e.g. surface-level old houses or wells.** Treat these as a first-class
candidate: man-made ruins on the surface (a ruined house of Brick 22 and Wood 6 with a broken roof, a stone well over a
short shaft to water or a cave), placed by generation like the old mine (D-200: stand on the real ground, never float,
place nothing rather than block; keep out of the spawn columns and the arena; reachability and traversal tests must
hold). Wood burns, so a ruin can catch fire: good, if bounded. A well that opens into the caves is a nice second way
down; a well over a pocket of water is a nice landmark. Show them in screenshots on two seeds at M and L.
Every sim change keeps every invariant (sleep invisibility, bounded work, unique salts, the enemy budget: a large
Survival world already generates exactly `MAX_ENEMIES` = 64).

## Track C, phones and performance
**Cap $25. Branch `phone-perf`, worktree `/tmp/wt-phoneperf`, ports 8082 / 5182, data `/tmp/phoneperf-*`.**
From FUTURE.md's "Phone play follow-ups" and "Menu follow-ups": the menu backdrop's 30 fps draw cap on phones and
pausing it behind settings panels (throttled 390 px rendering hit 167 ms frames); a taller camera window in portrait
(the world is a thin strip); a floating left thumb-stick if it fits. Measure before and after (frame times at 4x CPU
throttle, 390x844 and 844x390). Client-only unless you find otherwise.

## Track D, sound (the user's request, 8 Nov)
**Cap $20. Branch `sound`, worktree `/tmp/wt-sound`, ports 8081 / 5181, data `/tmp/sound-*`. Client-only.**
1. **Audit first**, into `docs/research/sound-report.md`: every event the game shows (sim `events()` kinds, damage
   causes in `client/toasts.ts`, every spell in `client/spells.ts`, enemies, the boss, biome hazards, pickups, heals,
   round start/end) against `client/sfx.ts`'s `play()` names and every `play("...")` call site; a table of what has a
   sound, what shares one, what has none.
2. **Build the most valuable gaps** (the user's examples first): **damage that sounds different by cause** (fire,
   acid, lava, gunpowder, falling rock, each enemy kind, the boss) on the local player's hits; **a distinct cast sound
   per spell** (all 15, including Freeze, Quake, Mudslide); **ambient water**: a large amount of moving water near the
   player makes a rushing sound, from the grid in the camera window (read-only, like the ambient layer:
   `client/ambient.ts`), volume by amount and distance, rate-limited, silent while catching up (the worker already
   suppresses sounds during replay). Synthesised in the existing style (D-178: no recorded assets).
3. Bounded: no sound per cell per tick; a cap on simultaneous voices; respect mute and the existing volume. A test for
   any pure helper (e.g. "which damage cause maps to which sound", "water-noise level from a grid window"), red first.

## Track E, chat (a new feature, the user's request, 8 Nov)
**Cap $30. Branch `chat`, worktree `/tmp/wt-chat`, ports 8080 is the user's: use 8079 / 5179, data `/tmp/chat-*`.**
The user: "a chat feature to allow players to communicate. Maybe computer browser-only, but pressing '/' allows the
player to type in a chat-visible room. If they @ a player then the message is bolded for that player."
- **Design constraints (CLAUDE.md, review them before designing):** chat is **not a sim input** (invariant 1: it never
  touches `push_input`); it is a server-relayed message to the room's members beside the lockstep, like
  `encodePlayerName` / `encodeAchievement` in `shared/protocol.ts`. Players see only plain names (`name#id` only in
  logs and the admin dashboard). The server rate-limits it (a member can't flood the room: e.g. a few messages per
  few seconds, a length cap, refuse control characters) and logs through `log.limited` / `log.event` with names in
  `shared/events.ts`, never one line per message's text unless that's in the catalogue; never logs the message body
  to the public dashboard. Render with `textContent` only (never innerHTML): a message is untrusted text.
- **The feature:** `/` opens a chat input on desktop (not while another input has focus; Escape closes; Enter sends);
  messages show in a small fading panel in the room, with the sender's plain name; **`@name` in a message is bold for
  the named player** (match the plain display names in the room; case-insensitive; the mention is bolded only on that
  player's screen). Phones: read-only is fine (show messages, no input), unless it's cheap to add.
- Decide and record: whether chat history is sent to a late joiner (a short ring, or nothing), whether spectators can
  chat, and what happens in a Survival round.
- **Tests, red first:** the server's relay and rate limit and length cap (`tests/net/`), the mention matcher (a pure
  function), and that a message with markup renders as text. **A cold Sonnet review** of the server side (rate
  limiting, logging, identity). **Two browsers in a real room**: one types, the other sees it; an @mention is bold
  only for the mentioned player.

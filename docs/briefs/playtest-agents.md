# Brief PT: two agent playtesters (a newcomer and a Survival player)

**Why:** the user wants an outside read of Simulta before the deploy: what a first-time visitor understands, where
the menus and controls confuse, what breaks, and what makes it fun or not. Agents can't play at 60 Hz or hear
the music. Say what you could and couldn't judge, and prefer concrete observations ("I pressed 6 and nothing told
me Fire was selected") to opinions about fun.

**Two Sonnet agents, in parallel.** Use no subagents, stay within about 60 tool calls, and write your report
**as you go** (each observation the moment you have it). **Do not edit any tracked file, commit or push.** Rules:
`rm` only on literal absolute paths; kill everything you start by PID and close every `agent-browser` session you
open before you finish. Use `agent-browser` via `zsh -ic '...'`, and set the viewport (1280x800 first) before
anything else. Screenshots go to `/tmp/pt-<you>/` (not the repo); attach the 3-5 that matter by copying them to
`docs/art/shots/pt-<you>-*.png` at the end.

| Agent | Server | What | Report |
|---|---|---|---|
| newcomer | `PORT=8105 DATA_DIR=/tmp/pt-newcomer-data node server/main.ts` | a first visit: the menu, naming, creating and joining rooms, the lobby, a second tab, a phone viewport | `docs/research/playtest-agent-newcomer.md` |
| survival | `PORT=8106 DATA_DIR=/tmp/pt-survival-data SIMULTA_DEV_TELEPORT=1 node server/main.ts` | a Survival descent in a real room, with dev teleport to reach depth, enemies and the boss | `docs/research/playtest-agent-survival.md` |

Build the client once first if `dist/client` is missing or older than `client/` (`pnpm build:client`). Don't both run
it: the newcomer builds; the survival agent waits until `dist/client/index.html` is newer than this brief. Create
your data directory first. Other agents use ports 5173-5177 and 8099-8104; don't touch them.

## Newcomer

Pretend you've never heard of the game. Open `http://localhost:8105/`.
- **The menu:** what is this game, from the menu alone? Is the backdrop (a live sand sim) readable behind the
  panels? What do the mode cards mean? What would you click first?
- **Naming and joining:** pick a name, create a Survival room, read the lobby. Is it clear what to do, how to ready
  up, and what the countdown means? Open the room's link in a **second session** (`--session pt-newcomer-b`) as a
  second player, and check both see each other, ready up together, and descend.
- **Controls:** find out how to move, aim, cast, switch spells and see health, from the screen only (the hotbar, the
  hints, the README link). Which took more than one try?
- **Sandbox:** open `/sandbox`, paint a few materials, watch them interact. Is it fun for a minute?
- **Phone:** reload the menu at 390x844. What's broken, clipped or unreadable?
- **Errors:** check the browser console in each session (`agent-browser console` or equivalent) and report
  anything red.

## Survival

Open `http://localhost:8106/`, create a Survival room, ready up (`r`), and descend. The dev-teleport flag lets the
page's `__devGoto(spell)` and `__devGotoEnemy(kind, dist)` work in this real room (kinds: 0 slime, 1 fire imp, 2 acid
slime, 3 worm, 4 boss); `__players` and `__boss` are readable. Use them to reach what walking can't in the time.
- Play a few minutes near the surface first, by keyboard and mouse: dig, cast, pick up spells. What's the feedback
  like when you hit, get hit, pick up, run out of charges?
- Fight each enemy kind. Can you tell what it is and what hurt you? Do you die without knowing why?
- Visit the boss (`__devGotoEnemy(4, 40)`). What happens? How long do you last, and what's readable about its
  attacks (phases, bolts, lava ring, summons)?
- Find a heal drop if you can (killed enemies drop them 1 in 3). Is it noticeable?
- Die. Is the spectator view and the "party fell" outcome clear? Can you find the way back to the menu?
- Note the step rate and any hitches you can see (`?debug=1` shows stats).

## Report shape

```
# Playtest (agent): <newcomer | survival>, 4 Nov
## What I could and couldn't judge
## Findings
### P<n> BUG | CONFUSING | FRICTION | DELIGHT | IDEA: <one line>
- what I did, what I saw (screenshot path), what I expected
- how much it matters for a first-time player
## Fun, honestly
A short paragraph: what pulled me on, what made me want to stop, what I'd change first.
```

End with a ranked "top 5 for the user" list.

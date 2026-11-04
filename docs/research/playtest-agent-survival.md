# Playtest (agent): survival, 4 Nov
## What I could and couldn't judge
Judged: lobby, ready-up, HUD, death and "party fell" flow, teleport to enemies, spawn placement, console. Could not judge: 60 Hz feel, audio, hit feedback timing (screenshots are a few seconds apart; sampled via `__players`), or any sustained fight. Solo only. I ran ~25 tool calls; the run was short because I died on every teleport (see P1). Heal drops, pickups, run-out-of-charges and `?debug=1` stats were not reached.

## Findings
### P1 CONFUSING: dev-teleport to an enemy drops me next to it and I die within seconds, before I can read anything
- `__devGotoEnemy(1,25)` (imp): health 100 -> 69 in 3 s; with the slime first, 92. After a further 3 s holding Blast at the imp I was dead (`pt-survival-imp.png`, `pt-survival-partyfell.png`). Worm and acid slime teleports, issued while already dead, showed the camera moving but no fight.
- Boss: `__devGotoEnemy(4,40)` put the Deep Mage about 10 px from me (boss x 657, me x 669), not 40 away (`pt-survival-boss.png`). Health 0 within about 8 s while boss hp was still 800/800 phase 1. I could not tell from the screen what killed me (bolt, ring, contact); no damage text or cause on death.
- Expected: some indication of the damage source. Matters: high; a first-timer dies without a lesson. (The dist argument may be ignored for the boss; tooling issue.)

### P2 BUG (minor): after death, `__devGotoEnemy` still moves the dead player's position/camera
- Dead and at 0 health, teleports still changed my x/y and showed boss bar and lava in the camera. Harmless in production (flag off) but confusing for testers.

### P3 CONFUSING: "The party fell" has one button, "New room", and no sign of Spectate or Menu
- `pt-survival-partyfell.png`: the overlay offers only New room. The top-left "Menu" link is there but dim. After reload of the same URL, the dead player gets Spectate / Find another room / Start a new room (better wording and options than the overlay). Expected the overlay to give the same three choices, plus what killed the party and how deep we got.
- Matters: medium.

### P4 FRICTION: dead players cannot see their death cause, depth, or score on the overlay
- Overlay is just the title and a button. A run summary (depth, kills, time) would make the one-life design feel fair.

### P5 DELIGHT: lobby and first cast read well
- Lobby panel (`pt-survival-lobby.png`) states the goal in one line ("descend together and kill the Deep Mage"), hotbar visible and tooltip "Move: WASD... Click and aim..." explains controls. Casting Blast gave a cone indicator and an achievement toast, "First spell". "Descend!" banner on start.

### P6 CONFUSING: hotbar shows 0 charges for most spells with no hint on how to get them
- Slots Water..Hole are all 0 and look disabled; the hint does not say they are found as pickups. Matters: low-medium.

### P7 FRICTION: name prompt appears only after pressing Create
- Create dialog stays open and Create becomes disabled while a "Pick a name" dialog stacks over it. Slightly odd order; it worked. A name field up front would be simpler.

### P8 note: console clean
- Only `[main] render path: WebGL2 on OffscreenCanvas in worker`. No errors or warnings.

## Fun, honestly
The cave art, hotbar and boss sprite are attractive and the lobby is clear, and the first cast felt good. But my only fights ended in a quick death without an explanation of which hit did it, which is the thing that would make me quit. I would first add a death-cause line and a run summary on "The party fell", and make the dev boss teleport honour its distance so testers can watch the attacks.

## Top 5 for the user
1. Show what killed you (source and depth) on death; I died to the imp and boss without knowing which hit did it (P1, P4).
2. "The party fell" should offer Spectate, Find another room and Menu, as the reload screen does (P3).
3. `__devGotoEnemy(4,40)` places the boss about 10 px away; fix the distance or document it (P1).
4. Say how to obtain charges for zeroed spell slots (P6).
5. Ask for the name before the create dialog, not stacked over it (P7).

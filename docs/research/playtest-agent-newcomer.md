# Playtest (agent): newcomer, 4 Nov
# Playtest (agent): newcomer, 4 Nov
## What I could and couldn't judge
Agent-driven browser (agent-browser), snapshots and screenshots; no 60 Hz feel, no audio.
## Findings
### P1 CONFUSING: Survival card says "NO DAMAGE" though it is "co-op, one life"
- Menu (pt-newcomer/menu.png). Survival and Sandbox both carry a green NO DAMAGE badge, Deathmatch red PVP. Reads as "no damage in this mode", contradicting "one life". Presumably means "no player-vs-player damage".
- Matters: first impression of stakes.
### P2 FRICTION: music button icon is a black glyph on a dark header
- Near-invisible note icon with "Music" label beneath, misaligned with the other header links.
### P3 CONFUSING: lobby "Waiting for 1" with one player
- Lobby (pt-newcomer/lobby.png): "Waiting for 1" in yellow with only me listed; unclear whether it means me or another player, and whether I can start alone. Also the controls hint toast overlaps the hotbar's middle slots while the lobby is up. Otherwise the lobby is clear: mode blurb, player list, Ready (R).
### DELIGHT: two-tab ready-up and descend works
- Alice created the room, Bob opened the link, was asked for a name, joined. Lobby listed both with ticks; both Ready gave a big "2... Descending..." countdown, then "Descend!" with both avatars spawned. No console errors (only "render path: WebGL2").
### P4 CONFUSING: Ready click in tab B needed a second try; pressing "r" via keyboard did nothing in my driven session
- Pressing `r` in both sessions left Alice ticked and Bob unticked (the keypress likely did not register in tab B, possibly because the unfocused page or the name field had focus). Clicking the button worked. Could be an agent-browser artefact; flagging as unverified.
### P5 FRICTION: players spawn on top of each other; names overlap ("Bob" label clipped over Alice's)
- d2.png: both avatars stand at one spot, labels collide.
### P6 FRICTION: spell hotbar shows "0" charges for most spells with no explanation
- Slots 4-0 show 0 and look dimmed; a newcomer doesn't learn they are pickups. The hint toast vanished quickly.
### P7 DELIGHT: achievement toast ("First spell - Cast any spell") appears on first cast; D moves the avatar, camera follows (e1.png).
### P8 CONFUSING (unverified): pressing 3 (keydown+keyup) did not move the highlight off Push in the hotbar; may be a driver timing artefact. A click on a slot is the reliable route.
### P9 FRICTION: sandbox hint toast covers palette buttons; default brush (4) draws very thin lines; palette scrolls off-screen right (Glass, Coal, Erase hidden with no scroll cue) (sb1.png)
- Lava, sand and fire painted together reacted visibly (fire flicker, smoke, sand/lava mix). Worked, mildly fun; world is a small box (fixed size, not shared view).
### P10 FRICTION: phone (390x844) menu is fine and stacks well, but the music button's black icon is hard to see, and in a room the header overflows (README clipped at right edge; ph2.png). Cards use the whole screen so Live rooms is below the fold.
### P11 DELIGHT: joining a room mid-descent gives a clear "The descent has begun" with Spectate / Find another room / Start a new room (ph2.png).
### P12 BUG (minor, phone): in that overlay the black canvas area is offset and the world is cut with a hard grey rule at y=255 and 645; the layout looks unfinished. Not verified beyond the one screenshot.
## Fun, honestly
The menu pitch is clear and the lobby-to-descent flow is smooth and fast. I could not judge feel. The first minute lacked guidance on what to do after "Descend!" other than a hint toast, and the zero-count hotbar looked like a dead UI.
## Top 5
1. "NO DAMAGE" badge on Survival contradicts "one life"; relabel (e.g. "CO-OP, no PvP").
2. Lobby "Waiting for 1" is ambiguous; say "Waiting for Bob to ready up" or "1 of 2 ready".
3. Phone room header overflows (README clipped); music icon black on dark everywhere.
4. Hotbar shows zeros for most spells with no explanation of pickups; hint toast disappears fast and covers the slots.
5. Both avatars spawn stacked with overlapping name labels; sandbox palette scroll hidden (Glass, Coal, Erase), brush thin by default.
Not judged: audio, 60 Hz feel, enemies/boss, ready via 'r' key (did not register in my driver; unverified).

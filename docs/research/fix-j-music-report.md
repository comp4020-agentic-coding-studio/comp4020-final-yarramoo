# Brief J report: synthesised music

## Commits (branch fix-j-music, not pushed)
- b5367db: `client/music.ts` engine (moods, look-ahead sequencer, pure mood selection), `getAudio()` in `sfx.ts`, `tests/net/music.test.ts` (7 tests pass).
- ec1bdce: wiring. `room.ts` (~12 lines: gesture start, "Music" button after `#muteBtn`, `updateMood` from `onPlayers` and the `round` case) and `menu.ts` (5 lines: `setMood("menu")`, gesture start, header button).
- Third commit: screenshots and this report.

## Moods
- menu: C major pentatonic, 66 bpm, triangle pads + sparse sine bell melody, sine bass.
- surface: D lydian, 84 bpm, triangle pads, plucky melody and plucks.
- caves: E dorian, 56 bpm, detuned saw drone (cutoff 260 Hz) and occasional sine plucks, no pad.
- deep: A minor, 62 bpm, thin saw pad, drone, bass heartbeat on beats 1 and 3 with a soft noise tick, rare square plucks.
- boss: D minor, 138 bpm, eighth-note saw bass ostinato, noise hit every beat, saw lead.
- victory: C pentatonic rising run, one bar, then falls back to menu.
- defeat: A minor falling line, 50 bpm, one bar, then menu.

## Verified
- typecheck, unit tests (mood tables in MIDI range, bars sorted and within the 8-voice cap, hysteresis, boss, stings).
- Browser (vite 5195): menu `__music` = mood menu, running, 4 live voices; the game page shows "Music on" next to "Sound on" (docs/art/shots/fix-j-game.png, looked at); after `__devGotoEnemy(4)` mood = boss, live 4, queue 20. Menu button seen in docs/art/shots/fix-j-menu.png.
- Not verified: I cannot hear audio, so the sound, balance and taste are for the user to judge. The depth moods (caves/deep) were covered by unit tests only, not driven in the browser. The 10-minute memory check was not run; nodes are disconnected after release and `__music.live` is the counter.

## Architectural decisions for review
1. Shared AudioContext: `sfx.ts` exports `getAudio()` ({ctx, destination, noise}). Music connects to `ctx.destination` through its own master gain, not sfx `master`, so the SFX mute leaves music alone. Alternative: a second context (wasteful, autoplay issues). Cost: music is not under the SFX master level; level is balanced by the 0.2 gain only.
2. Scheduling: 25 ms `setInterval` look-ahead of 0.1 s, bars planned by pure `planBar` into a queue. Alternative: per-note setTimeout (drifts). Cost: background-tab timer throttling to 1 s can drop notes (they are skipped if more than 50 ms late, never bunched).
3. Mood source: render-only, from the `players` message (cam.y, boss.hp>0) and `round`; selection is the pure `stepMood` with a 3 s depth hold; boss and stings are immediate. Alternative: a worker-side mood event (rejected, extra protocol). Cost: camera y, not avatar y, so spectators hear their camera's depth. Boss mood ends 3 s after the boss leaves the entities view.
4. Persistence and toggle: `sand.music` = "off"/"on" via `store`, default on; separate button ("Music on/off") in menu header and room header. Cost: autoplay-on-first-gesture means music starts the moment a player first clicks anything; some may want default off.
5. Mood changes crossfade over 2 s by swapping the bus (new bus per mood); chord changes happen only per bar since each bar is planned whole. Cost: a switch restarts the bar count at the next call.
6. Sting fall-back to menu uses a setTimeout on the engine; if the page stays on the end screen, menu-like music continues under the round banner.

## FUTURE.md ideas (suggested)
- Duck music under loud SFX (explosions) with a sidechain-style gain dip.
- A music volume slider rather than only on/off.
- Avatar-y instead of camera-y for mood, with a separate "spectating" calm.

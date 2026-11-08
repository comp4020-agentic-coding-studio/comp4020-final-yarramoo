# Juice pass: worker report

Client-only. Nothing in `sim/`, `shared/` or `server/` was touched; nothing here feeds an input (invariants 1, 9).

## What was built

- `96405ba` commit 1: `client/sfx.ts` (WebAudio synth, no files), `{type:"sfx"}` in `FromWorker`, `room.ts` plays it, a "Sound on/off" header button persisted under `sand.muted` via `storage.ts`, and context creation/resume on the first capture-phase pointerdown or keydown.
- `902644f` commits 2 and 3: the worker emits sfx for cast (one sound per spell), reject, impact, explosion (scaled by radius), knock, death, respawn, pickup, bag pickup. Shake: `shake()` helper with per-call duration, explosion shake scaled by radius and camera distance, a small shake on my own knock and my own Blast cast. A 120 ms white flash on a figure after EV_KNOCK (`PoseState.hitAt`).
- `5411bed` commit 4: Blast dig preview (a dashed ring in a DOM element, not in the sim render). `BLAST_DIG_RADIUS=4` and `BLAST_DIG_REACH=6` are mirrored in `client/spells.ts` (source: `sim/src/tuning.rs`). Screenshot: `docs/art/shots/juice-dig-preview.png`.
- Commit 5: this report.

## Verification

- `pnpm typecheck` green before each commit.
- Dev route `/game?world=game&avatar=1` on vite: the Sound button renders; after a click the AudioContext created an oscillator on a Blast cast (a patched `createOscillator` counted it), so the localSim path produces sfx. Pressing 2 and moving the mouse showed the dig ring (`#digPreview` not hidden).
- `pnpm test:net`: see the status line at the end of this file.

## Could not verify

- Actual sound quality, loudness balance, and panning: no audio output.
- Replay suppression on a real late join (needs a server with a long-running world). The rule is by reading, not by test.
- The dig-ring size and position by eye: the headless viewport rendered the game canvas tiny (about 267x150 px, with the ring about 4 px), so the committed screenshot does not show the ring clearly. The geometry was checked by numbers only (ring centre = chest + REACH along the aim, diameter = 2*RADIUS cells).
- White flash and shake by eye.

## Architectural decisions for review

1. **Sfx message shape**: `{type:"sfx", name, vol, pan, mag}`. The worker does the distance maths (it owns the camera) and sends final volume and pan; the main thread only synthesises. Alternative: send raw event kind plus cell position and let room.ts map it. Chosen because the worker already knows camera and "quiet" state and the message stays tiny. Cost: retuning falloff means editing worker.ts, and `SfxName` couples protocol.ts to sfx.ts (type-only import).
2. **Audio lives on the main thread** (`client/sfx.ts`), since a Worker has no AudioContext. One shared context, master gain (0 when muted), voice cap of 10 with a drop-newest policy, and a 24-events-per-frame bound in the worker.
3. **Replay suppression**: `quiet = net === "catching-up" || ls.fastForwarding`, evaluated in `spellFx` when events are drained, not when queued. Events queued during fast-forward are drained in a frame that is still catching up, so they are silent; events right after the switch to live play normally. Alternative: drop events at queue time (would also save particle work, but changes existing fx behaviour). Cost: the boundary frame could play one batch of the last replayed ticks.
4. **Own-action sounds are non-spatial** (`sfxSelf`, vol 1, pan 0); others use the camera-centre distance with a quadratic falloff (zero at 2.2 half-widths).
5. **Shake**: `shake()` keeps the stronger of the current and new shake; duration is now a variable (`shakeDur`). Explosion shake needs `mag >= 1` cell, in view only.
6. **Dig preview is a DOM ring**, positioned from the `players` message and the pointer, not a world-space rect. More reversible and keeps the worker out of aim state. Cost: it follows the camera at the 30 Hz players post, so a slight lag against the canvas.
7. The mirrored dig constants are not yet pinned in `tests/net/spells-table.test.ts` (outside my file list). Suggest adding a row there.

## Ideas for FUTURE.md (suggested only)

- Pin `BLAST_DIG_RADIUS/REACH` in `spells-table.test.ts`.
- Volume slider next to the mute button; a quieter ambient bed (cave drip, wind on the surface).
- Ring drawn in world space with an actual dig-disc cell mask preview.
- Per-material impact sounds (sand hiss, water plop) by reading the impact cell.
- Respect `prefers-reduced-motion` for screen shake.

`pnpm test:net` result: 39 files, 308 tests passed (run on the commit-4 tree).

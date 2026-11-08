# Brief J: synthesised music for the menu and the game

**Why:** the user, 4 Nov: "it would be good to have music for the game and for the main menu ... do synthesised
tracks for now". `FUTURE.md`'s "Music for the game and the main menu" entry has the context.

Read these first:
- `CLAUDE.md` (the client is render-only: nothing here touches sim state, invariants 1 and 9);
- `client/sfx.ts`: it already synthesises every sound effect with WebAudio and no files. Follow its style.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 80 tool calls. You work in the worktree
`/tmp/wt-music` on branch `fix-j-music`. Rules:
- `CLAUDE.md`;
- gate on exit codes chained with `&&`;
- `rm` only on literal absolute paths;
- **no pushing**;
- stop any vite you start;
- use **port 5195** for vite.

**Other workers are editing `client/menu.ts`, `client/room.ts` and `client/index.html` at the same time.** So:
- put the music engine in a **new file, `client/music.ts`**;
- you may make **only the minimal wiring** edits listed in step 3 to `client/room.ts`, `client/menu.ts`,
  `client/sfx.ts` and `client/index.html`. Keep each a few lines, so the session model can merge them by hand.

Build the wasm in the worktree first (`pnpm build:sim && pnpm build:sim:devpaint`, with
`PATH="$HOME/.cargo/bin:$PATH"`).

## 1. The engine (`client/music.ts`)

- **A small generative sequencer** on its own `GainNode` into the same `AudioContext` as `sfx.ts`. Export what
  you need from `sfx.ts`, for example a `getAudio()` that returns `{ ctx, destination }` once unlocked. Don't
  create a second context.
- **Scheduling:** use the standard look-ahead pattern. A `setTimeout` or `setInterval` tick of about 25 ms
  schedules notes about 100 ms ahead on `ctx.currentTime`, so timing doesn't drift with frame rate or
  background throttling.
- **Moods**, each a key or scale, a tempo, a chord loop, a voice palette (oscillator types, filter, envelope)
  and a density:
  - `menu`: warm and inviting, unhurried. Slow pad chords and a sparse pentatonic melody.
  - `surface`: light and curious (the game above `SHALLOW_TOP`).
  - `caves`: darker and sparser, with a low drone and occasional plucks (between `SHALLOW_TOP` and `DEEP_TOP`).
  - `deep`: tense, a minor mode, a slow pulse (below `DEEP_TOP`).
  - `boss`: driving, a faster tempo, a bass ostinato and a percussive noise hit (while the boss bar shows).
  - `victory` and `defeat`: short one-shot stings, then silence or a fall back to `menu`-like calm.
- **Crossfade** between moods over about 2 s. Change chord, never note, at bar boundaries so it doesn't jar.
- **Randomness** is cosmetic only: use a local xorshift as `sfx.ts` does. Never the sim's rng, never sim state.
- **Level:** music sits under the sound effects. Keep master music gain about 0.15-0.25, with gentle attack
  and release (no clicks), and a low-pass on pads.
- **Cheap:** at most about 8 voices at once. Stop and disconnect nodes after their release. No memory growth
  over 10 minutes; check with `performance.memory` or by counting live nodes in a debug counter.
- **API (suggested):**
  - `startMusic()`, called after unlock;
  - `setMood(mood)`;
  - `setMusicMuted(b)` and `isMusicMuted()`, persisted under `localStorage` key `sand.music` (via
    `client/storage.ts`'s `store`, like `MUTE_KEY`);
  - `stopMusic()`.

  **Muting sound effects should not mute music, and the reverse.** The music toggle is its own setting.

## 2. Mood selection (render-only)

- **Menu:** `menu`.
- **Room:** derive the mood from what the worker already posts:
  - the camera centre's y against `SHALLOW_TOP`/`DEEP_TOP` (`shared/stats.ts`);
  - `players.boss` (non-null and alive means `boss`);
  - the `round` message (`victory`/`defeat` stings).
  
  The sandbox uses `surface`, or its own gentle mood.
- Add hysteresis: only switch depth mood after the camera has been in the new band for about 3 s, so hopping
  across a boundary doesn't thrash.

## 3. Minimal wiring (keep each edit small)

- `client/sfx.ts`: export access to the context and destination (a few lines).
- `client/room.ts`:
  - after the existing unlock listener (~line 155), start music on the first gesture;
  - call `setMood` from `onPlayers` (camera y and boss) and from the `round` case;
  - add a **"Music on/off" button** beside `muteBtn`, created in `room.ts` and inserted next to `#muteBtn`
    (create the element in JS rather than editing the HTML header, to avoid conflicts).
- `client/menu.ts`: start `menu` music on the first pointerdown or keydown, and add a small "Music" toggle in
  the menu header (one button, created in JS).
- `client/index.html`: none if possible. If you need CSS, put it in `music.ts` as a small injected
  `<style>`, or use the existing button classes (`btn secondary small` on the menu, the `muteBtn` style in
  rooms).

## Verify

- `pnpm typecheck`.
- **A unit-ish test** (`tests/net/music.test.ts`, vitest, no browser) for the pure parts:
  - the mood-selection function (y and boss to mood, hysteresis);
  - the scale and chord tables (valid MIDI ranges);
  - the note-scheduling function produces notes in increasing time order and within the voice cap.
  
  Factor the pure parts so they're testable without WebAudio.
- **The browser look:**
  - open `/` and `/game?world=game&avatar=1&cfg=survival` on vite 5195 in `agent-browser --session jm`
    (through `zsh -ic`, viewport 1280 x 800);
  - click once to unlock, check `window.__music` (expose a small debug object: current mood, live voices,
    notes scheduled) changes mood when you `__devGotoEnemy(4)` (the boss) and when the camera goes deep;
  - screenshot the header buttons. Audio can't be heard by you, so **say so plainly**: the user will judge
    the sound;
  - close the session and kill vite.

## Commit checklist (commit each separately)

- [ ] 1. `client/music.ts`: engine, moods, tests.
- [ ] 2. Wiring: sfx access, room mood and button, menu music and button.
- [ ] 3. Screenshots (`docs/art/shots/fix-j-*.png`, looked at) and your report.

Gate per commit: `pnpm typecheck && npx vitest run --config vitest.net.config.ts tests/net/music.test.ts && git commit ...`

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/fix-j-music-report.md` as you go. It should cover:

- per commit: the hash and what changed;
- each mood's design in a line (scale, tempo, voices);
- what you couldn't verify (the sound itself);
- "Architectural decisions for review": the shared AudioContext, the scheduling, the mood source, persistence and
  the separate toggle. For each: what you chose, the alternatives, why, and what it costs later.
- FUTURE.md ideas, suggested only.

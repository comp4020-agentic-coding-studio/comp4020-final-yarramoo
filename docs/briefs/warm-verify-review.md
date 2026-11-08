# Brief: cold review of the warm-verify `server/` diff (Sonnet, read-only)

Written 8 Nov by the Opus lead of backlog item 1. You are a **read-only reviewer**: you change no code, run no tests,
start no servers and dispatch no agents. **Cap: about $3; stop after about 60 tool calls.**

## What to read
- Worktree `/tmp/wt-warm` (branch `warm-verify`). The diff under review: `cd /tmp/wt-warm && git diff multa -- server/ shared/events.ts`
  (this includes uncommitted working-tree changes; review the working tree as it is).
  Files: `server/verify.ts` (rewritten), `server/verify-worker.ts`, `server/world.ts` (lane open on first join,
  release on last leave and `shutdown()`, the room passed to `check`), `server/main.ts` (verifier options), `shared/events.ts`.
- Context, only as needed: `server/main.ts` room lifecycle (`scheduleUnload`, `deleteRoom`, `discardIfFreshlyLoaded`,
  `failWorld`, `getOrLoadRoom`, the room-load memory gate `ROOM_LOAD_MEMORY_CAP_BYTES`); `server/world.ts` `loadFromDb`
  (start-up verify, D-014: "unavailable" must refuse to start, never reset) and `checkUpload`; `sim/src/lib.rs` `restore`
  and the snapshot header layout in `sim/src/snapshot.rs` (the worker reads seed and config at bytes 38..62).
- Do not read the design notes first; read the code cold. Afterwards you may compare with `docs/research/warm-verify-report.md`.

## What the change claims (check each against the code)
1. One worker ("lane") per occupied room, prewarmed with the room's own seed and config (from the server, never an
   upload) on the first join; later verifies of that room are warm. Rooms without a lane, and start-up checks, use a
   one-shot overflow worker (cold, as before).
2. The trust path is unchanged: decompression with the size cap, restore, and the exact tick and hash comparison; a
   hostile snapshot is still refused. A lane additionally refuses a snapshot whose seed/config differ from its room's.
3. A timeout kills only that lane's worker and fails only its jobs; a timed-out room is barred from a new lane until released.
4. A lane is terminated (after an in-flight verify answers) when its room empties, unloads (including an owned sandbox's
   unload-without-delete), is deleted, or the server closes. Memory: a byte budget (100 MB estimated) and a cgroup cap (160 MB).
5. The warm-up has its own bound (`LANE_WARM_TIMEOUT_MS` 120 s, or 12x an overridden job timeout); a job's own 10 s
   clock starts once the world is generated.
6. Start-up's "unavailable means refuse to start" (D-014) still holds. The process does not exit mid-await (the
   worker ref/unref rule in `idle()`).

## Look especially for
- Any path where a verify result is attributed to the wrong job, room or worker generation (a late message from a killed
  worker; `nextId` shared across lanes; `this.worker !== w` guards).
- Leaks: a lane never terminated (room reset via `World.reset`, `failWorld`, a join refused after load, a reload racing a
  drain), a worker left `ref`'d so the process cannot exit, timers left armed.
- A hostile client making the server do unbounded work or hold unbounded memory (many rooms, rapid join/leave churn
  re-opening lanes and regenerating worlds, an L room's 120 s warm-up).
- The barred set: can a room be barred forever, or never barred? Can churn (join/leave loop) defeat the bar?
- Logging rules (CLAUDE.md "Server logging and identity"): every event via `log.event`/`log.limited` with a catalogued
  name; anything a client can trigger repeatedly is rate-limited; no raw IPs or tokens.
- Anything about memory accounting that is wrong (estimate vs real; cgroup read; the 160 vs 200 MB relationship).

## Output
Write `/tmp/warm-probe/review-warm-verify.md` **as you go** (create it first with a header, append each finding as you
confirm it), so a run that dies still leaves something. Per finding: severity (S1 must fix before merge / S2 should fix /
S3 note), file:line, what happens, a concrete trigger sequence, and a suggested fix. Separate what you **confirmed in
the code** from what you **suspect**. End with "Architectural decisions for review" (choices you think the session model
should weigh) and FUTURE ideas, if any. Never use `rm`; if you ever need to, it names an explicit literal absolute path.
Your final message: a short list of findings by severity and the file path.

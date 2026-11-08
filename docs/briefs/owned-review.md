# Brief owned-review: cold review of the owned-sandbox server diff (Sonnet, read-only)

You are a **Sonnet reviewer**. Read-only on code: do not edit any file except your review. Do not dispatch agents.
Do not run servers, vite, the gate or `pnpm test:net` (the lead does). You may run single files:
`cd /tmp/wt-owned && pnpm vitest run --config vitest.net.config.ts tests/net/<file>.test.ts`, only after checking
`pgrep -fl "cargo test|vitest|test:determinism"` shows nothing running. At most about 35 tool calls.

## What to review
`cd /tmp/wt-owned && git diff multa -- server/ shared/` (branch `owned-sandbox`). The feature: a player may own one
persistent sandbox room. Anyone with the link can join and paint; only the owner can delete it; it is never swept by
the empty-room sweep, but it unloads from memory when empty and reloads on the next join. Routes: `GET/POST
/api/sandbox`, `DELETE /api/sandbox/:code` (Bearer token = the hex token `POST /api/players` returned). Ownership
and delete are a **trust path**. Read the surrounding code too (`server/main.ts` room lifecycle: `scheduleUnload`,
`deleteRoom`, `sweepRooms`, `getOrLoadRoom`, `discardIfFreshlyLoaded`; `server/rooms.ts`; `server/identity.ts`;
`server/db.ts` migrations and `evictUnjoined`). Don't assume the diff is right, and don't assume it's wrong.

Questions worth answering (not a checklist; find what's actually there):
- Can anyone but the owner delete, or make the server delete, an owned room (sweep, unload timer, failWorld,
  discard-if-freshly-loaded, a race between DELETE and a HELLO that is mid-load, a DELETE during a snapshot verify)?
- Can a player get two owned rooms, or take over someone else's? Can the code-in-the-path be abused (case, length)?
- Does delete leave anything behind (rows, timers, `worlds`/`tickSamples`/`live` entries, sockets) or crash the
  process (an exception outside a try in a request handler)?
- Does an unloaded owned room reload with its state? Can memory/slot caps be bypassed by owned rooms?
- Foreign keys: `rooms.owner_player_id references players(id)` with `PRAGMA foreign_keys = ON`. Any path that deletes
  a player (eviction) and would now throw?
- Logging rules (CLAUDE.md "Server logging and identity"): every event name in `shared/events.ts`, client-repeatable
  refusals through `log.limited`, no raw IP or token, `name#id` only in logs.
- Survival and Deathmatch rooms must stay exactly as ephemeral as before.

## Output
Write `docs/research/review-owned-sandbox.md` **as you go**: each finding with severity (S = must fix before merge,
N = should fix, M = minor), the file:line, the evidence (the code, the sequence of events), and a concrete fix. Say
also what you checked and found sound. End with a section "Architectural decisions for review" for any design choice
you think the lead should reconsider.

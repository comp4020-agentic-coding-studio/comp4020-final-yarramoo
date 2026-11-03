# Brief F report (worker, fix-f-client)

## 1. Catch-up after a hidden tab
Cause confirmed: worker.ts only fast-forwarded when `net === "catching-up"` (set on connect/resync/reconnect). A hidden
tab stayed `live` and ran `ls.plan()`: at most 4 + 4 = 8 ticks per frame (~480/s at 60 fps, 240/s in practice).
Fix: `driveFrame` + `CATCHUP_THRESHOLD = 120` in `client/lockstep.ts`; the worker frame loop calls it. Backlog > 120
ticks sets `catchUpTarget = received` and `net = "catching-up"` (overlay shows, `gameFrame` does not run, so no Pos
and no casts); back to live through the existing path (`sendLive`). HASH/claims are gated on `tick > catchUpTarget`
so nothing is re-sent. New `hidden` worker message (from `visibilitychange`) stops Pos and casts while hidden; no
Leave sent.
Test `tests/net/hidden-tab.test.ts`: red with the threshold check disabled (`sawCatching` false), green with it.
Numbers: before, 91,384 ticks at <=480 ticks/s is >= 190 s of pure replay (observed ~6 min at 240/s, while the world
kept advancing). After: probe on an empty-world backlog of 3001 ticks, fast-forward ran at ~92,000 ticks/s (32 ms
total), so 91k ticks is ~1 s on an empty world; a busy world is slower but is bounded by the 12 ms/frame budget,
roughly 5-20x the old rate or better. (Measured on empty ticks only; not measured on a populated survival room.)
(c) Snapshot instead of replay for huge backlogs: skipped. The resync path closes the socket with 4001 and has a
budget; reusing it needs a server decision about when to hand out a snapshot, more than a few lines.
(b) Server inactivity: recommend (not built) that the server mark a player silent for N minutes (no Pos/keepalive;
the client sends a keepalive Pos every ~POS_KEEPALIVE_TICKS while standing) as inactive/away, so lobby ready-up
does not wait on a hidden tab. Server change, flagged only.

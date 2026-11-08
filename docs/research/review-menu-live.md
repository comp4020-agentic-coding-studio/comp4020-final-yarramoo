# Review: menu non-UI changes (3162f71..fda054b)
Overall: nothing serious. No blockers. Everything below was checked in code unless marked suspected.

## 1. /api/live
- Leaks: none found. Payload is {players, rooms, deaths[{victim,killer,self,cause,bag,mode,at}]}. Names come from nameOfVisitor (plain visitorName, no #id). Death is recorded only if room.visibility === "public" (server/main.ts ~581). No ids, IPs, room codes or room names. Nameless victims are skipped; a killer with empty name is skipped (condition `killer === null || killer !== ""`).
- nit (server/main.ts:~571): nameOfVisitor falls back to db.playerNames, so a victim who has left is still named. That is the name they chose, so fine. Suspected only: if the DB ever returns a default like "player" for never-named visitors, it would be published. Not verified; the `""` skip assumes unnamed means empty.
- Cheapness: fine. A death sets cached=null but not cachedAt, so the next request recomputes once and re-caches. Recompute work is bounded by (deaths + 1 per 2 s), not per request. listPublicRooms is one SQL query, limit 100, plus playersIn per room (a members filter). A poll storm costs JSON string reuse only. Many deaths per second across rooms could recompute that often; still small. nit.
- Memory: ring is capped at 20 entries; nothing else grows. Fine. Public room visibility is fixed at creation, so "turns unlisted" cannot happen. Deaths from a room later ended or deleted stay in the ring until pushed out (up to 20, with no age limit), so an old death can show with a stale `at`. nit: harmless; the client shows the age.
- No per-call logging, good (matches rules). Method check returns 405 for non-GET.
- Client poller (client/menu/live.ts startPoll): stops on document.hidden, restarts on visible with an immediate run, no overlap (busy flag). Errors: fetchLive returns null and the UI hides the stats; the poll interval stays constant at 5 s (no backoff). nit: no exponential backoff on errors, but 5 s fixed with the server cache is cheap. Also nit: startPoll's visibility listener is removed in the returned stop; callers do stop it (screens.ts ~128).

## 2. Worker goto and cfg "menu"
- goto (client/worker.ts:1243): `if (!localSim) break;` so it is ignored for networked rooms. Only moves the local Avatar via teleport; the sim learns of it through the controller's normal Pos path (invariants 1, 9 hold; the sim ABI is unchanged). Pending menuGoto is applied once the avatar exists.
- cfg "menu" only has effect in the `m.local` branch (local sim). menuBackdrop is a module global set only there; the networked init path never sets it, but also never resets it (worker is per page, and the menu worker is separate from a game worker, so suspected-safe). nit: if the same worker were ever reused from menu to a networked room, the "me" marker would stay hidden. Not currently the case: menu-preview creates its own worker (checked).
- Invariant 9: backdrop-config.ts comments say seed and vignettes are constants found offline; menu-preview.ts sends goto with constant VIGNETTES coordinates. I did not find any sim output (entities) used to choose inputs at runtime in the diffed files. I did not review the emitters/director (client/menu-preview.ts emittersFor) beyond the goto call; flagged as not checked.
- nit: `damage: 0` etc. only matter locally; MENU_BACKDROP goes through encodeConfig, so it must pass decodeConfig; the test tests/net/menu-backdrop.test.ts is said to cover it (not run).

## 3. Death text injection
- Safe. deathLine -> formatDeath builds a plain string; screens.ts:121 uses el("span","x",text) where el sets textContent (screens.ts:18). Room names also use textContent (screens.ts:458). No innerHTML in client/menu/*.ts (grep). Names are capped at MAX_NAME_CHARS=24 on registration (shared/protocol.ts:58), checked only by constant, not traced through the register route.
- nit: the server does not validate/escape names in /api/live, but it is JSON, content-type application/json, no-store; other consumers must also use textContent.

---
**Session model's check (7 Nov):** the suspected item resolves: `GameDb.playerNames` (`server/db.ts:340`) returns
only stored `display_name` values, which registration requires a player to choose; it never invents a default.
Nits accepted: no poller backoff (fixed 5 s), stale deaths age out of the 20-ring, `menuBackdrop` never reset (the
menu runs its own worker).

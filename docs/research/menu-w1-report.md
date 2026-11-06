# Menu W1 report: GET /api/live

Commit d6ad026: `server/live.ts` (pure ring + 2 s cache, injectable clock), route and death wiring in `server/main.ts`, `tests/net/menu-live-api.test.ts`.

## Tests
- Red first: the new test file failed at import ("server/live.ts" missing), `Tests: no tests`, 1 file failed.
- Green: typecheck clean; 4 files, 8 tests passed (new, menu-live-counts, imports, claims-rooms).
- Full `pnpm test:net`: Test Files 60 passed (60); Tests 422 passed | 1 skipped (423).
- Spend: start 130.28, end 132.01 (about $1.7).

## Architectural decisions for review
1. **Ring and cache in a pure module `server/live.ts`**, not inline in main.ts. Alternative: closures in main.ts. Chosen for injectable-clock tests. Cost: none.
2. **Cache invalidated by a death**, otherwise 2 s TTL from the last computation (a clock going backwards also recomputes). A player joining is visible up to 2 s late. Cost: a new death shows at once, but a poll storm after a death recomputes once per death only.
3. **Entries are stored with the final `self`/`killer` already derived** and sent as is (`self` always present). Stored in memory only: a restart empties the death log. Alternative: persist in the db (heavier, not asked).
4. **Entry skipped if victim name is empty, or the killer is non-null with an empty name** (a killer who was never named is dropped with the entry rather than shown as a nameless kill). Flag: could instead show the death with `killer: null`.
5. **Public check at death time** via `rooms.getRoomById(w.id)`; fixed worlds have no room row and never log. `rooms` null (no db) gives `{players:0, rooms:0, deaths:[]}` naturally.
6. `rooms` counts only loaded public rooms with at least one non-spectator; players counted through the existing `playersIn`.

## FUTURE.md ideas
- Persist the last N public deaths so the log survives a restart.
- Send `rooms` per-mode counts so the menu can show "3 in Survival".

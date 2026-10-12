# Hub: open crews on the home page

**Shipped.** Home page "Open crews" (lobbies under 24 h with a free seat; code, sequence, filled/total, callsign links, free seats, age, Join; most filled first then newest; max 20) and "In flight" (code, sequence, crew, T-clock as of render, Watch; max 10). People without a callsign see both read-only under the callsign form. "Join the next crew" button for those with one. `GET /hub/fragment` returns the two sections; `GET /hub/stream` is a public SSE; `public/hub.js` swaps `#hub`.

**Quick join** (`POST /quick-join`, CSRF, 10/min per crew like /missions, own limiter instance). One transaction in `store.quickJoin`: if the caller already holds a seat in any lobby, redirect there (no second seat); else take the first free role of the open lobby with fewest free seats (ties oldest); else create Kestrel-1 and seat them as Flight Director. The seats primary key still guards each claim, and node:sqlite is synchronous, so races cannot double-seat.

**Live path.** `publishHub()` (store.ts, 300 ms debounce) is called from createMission, claimSeat, releaseSeat, stale-lobby deletion, startMission and the done branch of commit. It publishes bare `{type:"hub"}`; the client refetches the fragment, deferring while a form input is focused. A 30 s timer refreshes ages and clocks.

**Tests** (`spec/hub.test.ts`, 4): lobby visibility and move to In flight; stream ping within 1 s; quick join; racing quick joins.

**Verified.** typecheck; `pnpm check` green twice on fresh app (207 tests). Two agent-browser sessions: h1's list updated with no reload after h2 created and seated. Screenshots `hub-home.png`, `hub-home-phone.png`.

**Weak spots.** T-clock reads persisted state, up to 5 s stale. Parallel specs could push a test lobby past the 20 cap. Quick join is not rate-limited with the same counter as /missions, only the same numbers. No "start" notice beyond a section refresh.

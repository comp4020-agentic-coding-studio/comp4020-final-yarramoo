# N2 report: UX fixes and hover names

Branch `ux` (worktree /tmp/wt-ux). Client only, so no determinism run. Gate: `pnpm typecheck && pnpm test:net`.

## Done
1. Party-fell and Victory banner: same three exits as the late panel (shared `exitPanel()` in `client/room.ts`) and a depth line. The depth is the deepest y of any living player this client has seen (`deepest` on the worker's `players` message), and the line says so.
2. Death cause: `youDiedText` in `client/toasts.ts` ("Killed by a Fire imp", "Your own Bomb", "Burned in lava"), carried from EV_DEATH to the death overlay as `me.deathText`. Test in `tests/net/toasts.test.ts` covers every spell, CAUSE_*, and enemy kind.
3. Survival badge reads "Co-op". 4. `#musicBtn svg` gets the stroke style (menu music icon). 5. Lobby reads "1 of 2 ready", no names.
6. Empty slots dimmed (opacity .45) with tooltip "Find pickups in the caves". 7. Phone header: icon-only Sound/Music/Share under 520 px. 8. Overlapping labels lifted 15 px each. 9. Sandbox palette wraps.
Part B: `client/hover.ts` (pure `lookupHover`), `hover` messages both ways, 200 ms rest, mouse only, hidden on key, button, leave. Test `tests/net/hover.test.ts` pins enemy > player > pickup/bag/heal > material.

## Screenshots (docs/art/shots/)
n2-menu.png, n2-sandbox-1280.png, n2-sandbox-phone.png (header fits, palette reachable), n2-lobby-count.png, n2-labels-and-hover.png, n2-hover-enemy.png.

## Not verified in a browser
The death text and the party-fell overlay: I did not die live (no lava near the spawn); they are covered by the unit test only. Two avatars at the exact same spot (label offset) also not reproduced live. The "before" screenshots were not taken.

## Architectural decisions for review
- Hover lookup runs on the worker, on request from the main thread after 200 ms rest (chosen over a per-frame lookup or a main-side copy of entities). Costs one message per rest; nothing per frame. Enemy hit boxes in `client/hover.ts` are hand-set approximations, not from the sim.
- `deepest` is client-observed, not authoritative (a client that joined late or never saw a far player undercounts). Alternative: server stat. Reversible.
- `players` message gained `deepest` and `me.deathText` (client-only protocol, not shared/protocol.ts).

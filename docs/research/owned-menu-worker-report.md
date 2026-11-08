# owned-menu worker report

## Changed
- client/menu/router.ts: `mine` route (#mine, parent title). tests/net/menu-router.test.ts: parse/round-trip and parent cases.
- client/menu/screens.ts: title "My world" button (`.mn-mine`, no CSS added); `shareBlock` helper factored out of `shareScreen`; new `mineScreen` (GET/POST/DELETE /api/sandbox, in-page confirm, errors in `.mn-err`, names via textContent).
- client/room.ts: `RoomTarget.owned`; owner-only "Delete world" link to `/#mine` after the menu link.
- client/worker.ts: onclose treats 4003 like 4001, "This world was deleted".

## Red then green
Red (before route): "Tests 2 failed | 12 passed (14)". Green after: "Tests 14 passed (14)". typecheck exit 0 each commit.

## Not done
No browser check (not allowed). Delete confirm after a 404 on DELETE is treated as success.

## FUTURE ideas
Show the owned world on the title screen as a live count; "rename my world".

## Architectural decisions for review
- Token read from localStorage on each call (store.get), not cached: reversible, costs nothing.
- Room-page owner check is a second fetch (/api/sandbox) rather than the server returning "mine" in /api/rooms: avoids server change; costs one request per owned-room load. Alternative: server-side `mine` flag.
- Delete only lives on the menu screen; the room link just navigates to /#mine.

# Brief owned-menu: "My world" in the menu and on the room page (Sonnet worker)

Written 8 Nov by the Opus lead for the owned-sandbox feature. You are a **Sonnet worker**. You do not dispatch agents.
Work only in `/tmp/wt-owned` (branch `owned-sandbox`). Never touch `/Users/mitch/code/...` or port 8080. Never push.

## Cap
- At most about 40 tool calls. If stuck after 3 attempts at the same thing, stop and write what you found.
- Write your report to `docs/research/owned-menu-worker-report.md` **as you go** (start it after your first read), not
  only at the end.

## What already exists (server, committed; do not change `server/` or `shared/`)
- `GET /api/sandbox` with `authorization: Bearer <sand.token>` returns `{id, code, name, mode, visibility}` of the
  caller's own sandbox, or 404 if they have none; 401 if the token is unknown.
- `POST /api/sandbox` (same header) creates it or returns the existing one: 201 or 200,
  `{id, code, name, visibility, created}`. 429 rate limited. The name is "<player>'s world".
- `DELETE /api/sandbox/<CODE>` (same header): 200 `{deleted}` for the owner; 403 for anyone else; 404 unknown.
  Members of a deleted world are closed with WebSocket close code **4003** ("world deleted").
- `GET /api/rooms/<CODE>` now also returns `owned: boolean`.
- The token is `localStorage["sand.token"]` (64 hex), via `store.get(TOKEN_KEY)` in `client/storage.ts`.
  `ctx.ensureName()` in the menu registers a player first if there is no token.

## The job
1. **Menu (`client/menu/screens.ts`, `client/menu/router.ts`, `client/menu.css` only if needed)**:
   - On the **title screen**, a third button "My world" (keep the two big ones as they are; the third can be a normal
     button under them). Clicking it: `ctx.ensureName()`, then go to a new route `#mine`.
   - New route `{ kind: "mine" }` <-> `#mine` (router: parse, format, parent is title). Add cases to the router test
     `tests/net/menu-router.test.ts`.
   - The **"My world" screen**: `GET /api/sandbox`. If 404: heading "My world", a line "Your own sandbox. It stays
     until you delete it. Anyone with the link can paint in it.", and a "Create my world" button that POSTs and then
     shows the existing-world view. If it exists: heading with its name, the room code big, the link field and
     "Copy link" (reuse the share screen's pieces: factor the shared code/link/copy block out of `shareScreen` into a
     helper rather than copy it), an "Enter" button (`/r/<code>`), and a **"Delete world"** button (class `lava`)
     that asks for confirmation in the page (a second "Really delete? This can't be undone." step with "Delete" and
     "Cancel"; not `window.confirm`), then DELETEs and returns to the empty view. Errors (401/429/5xx) show a short
     line in `.mn-err`, never a crash. A back row like the other screens.
   - Names are rendered with `textContent` only (they are user input).
2. **Room page (`client/room.ts`, small edits only)**: `resolveRoomTarget` already fetches `/api/rooms/<code>`; carry
   `owned` into `RoomTarget`. When `owned` is true and the visitor's token's `GET /api/sandbox` returns this room's code,
   show a small link "Delete world" next to the menu link (or in the header) that goes to `/#mine` (the menu's screen
   does the confirm and the delete; do not duplicate the delete on the room page). A non-owner sees nothing extra.
   The header title already shows the room's name ("Mitch's world"), so nothing else is needed there.
3. **Close code 4003 (`client/worker.ts`)**: this file is in the gate's full tier, so keep the change to the
   `sock.onclose` block only: treat 4003 like 4001 (no reconnect), with the message "This world was deleted". Show
   it in the existing `note` like the other rejections.

## Files you may touch
`client/menu/screens.ts`, `client/menu/router.ts`, `client/menu.css`, `client/room.ts`, `client/worker.ts` (onclose
only), `client/index.html` (only if a header slot is needed), `tests/net/menu-router.test.ts`, your report.
Nothing else. Every `rm` names an explicit literal absolute path (never a variable or a glob on one).

## Verify
- `pnpm typecheck > /tmp/owned-menu-tsc.log 2>&1; echo $?` must be 0.
- `pnpm vitest run --config vitest.net.config.ts tests/net/menu-router.test.ts` green; show the new router case red
  first (run it before adding the route).
- Do **not** run the full gate or `pnpm test:net`; the lead runs it. Do not run vite or any server; the lead looks at
  it in a browser. Before any test run, `pgrep -fl "cargo test|vitest|test:determinism"`: if another run is going,
  wait for it.

## Commit checklist (one commit each, `git add` files by name, never `-A`)
- [ ] router route + its test
- [ ] the "My world" screen (and the shared share-block helper)
- [ ] room page link + worker 4003
Each commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Commit only with
typecheck at exit 0 (`pnpm typecheck > /tmp/x.log 2>&1 && git commit ...`).

## Report (`docs/research/owned-menu-worker-report.md`)
What you changed (file and function), the red-then-green router test output, anything you could not do, ideas for
FUTURE.md, and a section **"Architectural decisions for review"**: each choice later work builds on (what, the
alternatives, why, the cost later). When unsure about a hard-to-reverse choice, take the more reversible one and flag it.

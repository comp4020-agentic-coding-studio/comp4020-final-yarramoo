---
name: dev-server
description: Start, restart or redeploy Simulta's local dev server so the user (or the agent) can play the current build at http://localhost:8080. Use after any change to sim/, client/, shared/ or server/ that the user is about to look at, when the user says "the test server doesn't work", "it says new version, reload", "restart the server", "let me play it", or before handing a build to the user for a playtest.
---

# The local dev server

The user plays the build on **http://localhost:8080**. It is a real server (`node server/main.ts`) serving the built
client from `dist/client`, with its world data in `/tmp/simulta-dev-data`. It is not vite: there is no hot reload.

## The rule this skill exists for

**The server and the browser must run the identical `sim.wasm` (invariant 10).** The server reads
`sim/target/wasm32-unknown-unknown/release/sim.wasm` *once, at start*, and refuses any client whose wasm hash differs
with `sim build mismatch: new version, reload`. The browser loads `dist/client/sim.wasm`, which `pnpm build:client`
copies from that same target file.

So **any rebuild of the wasm means the server must be restarted**, or every fresh tab shows "new version, reload" in
the bottom left and never connects. Rebuilds happen more often than they look:

- `pnpm build:client` and `pnpm dev:client` (both run `pnpm build:sim`);
- the gate: `cargo test`/`cargo build` and `pnpm test:determinism` rebuild `sim/target`;
- a merge or checkout that changes anything under `sim/`.

On 5 Nov the agent rebuilt `dist/` to show the user a fix and left the old server running; the user's next reload
was refused. A green test run said nothing about it. **Rebuild, restart, then open it and look, every time.**

## Redeploy (rebuild and restart)

Do not rebuild while a gate is running in this working tree (it is building and testing the same files): wait for it,
or check with `pgrep -fl "cargo test|vitest"`.

1. **Build:** `pnpm build:client > /tmp/build-client.log 2>&1` and check the exit code (it builds the wasm too).
2. **Find the running server** by its port, and look at it before killing it:
   ```bash
   lsof -ti tcp:8080 -sTCP:LISTEN          # the PID
   ps eww -p <PID> -o command | tr ' ' '\n' | grep -E '^(PORT|DATA_DIR)='   # its settings
   ```
   Only kill a `node server/main.ts` process. Port 8080 also shows Chrome helper processes as *clients*; the
   `-sTCP:LISTEN` filter excludes them. Kill by the literal PID: `kill <PID>`.
3. **Start it again with the same settings**, so the user's world survives:
   ```bash
   (PORT=8080 DATA_DIR=/tmp/simulta-dev-data nohup node server/main.ts > /tmp/simulta-dev-server.log 2>&1 &)
   ```
   Run it from the repo root (it resolves `dist/` and `sim/target` from there).
4. **Verify the hashes agree and a client is accepted** (not just that the page returns 200):
   ```bash
   shasum -a 256 sim/target/wasm32-unknown-unknown/release/sim.wasm dist/client/sim.wasm   # must match
   grep -E '"ev":"server.start"' /tmp/simulta-dev-server.log | tail -1                     # build = first 12 hex
   ```
   Then join in a browser (below) and check the connection dot turns green and nothing new appears under
   `grep '"ev":"hello.rejected"' /tmp/simulta-dev-server.log`.
5. **Tell the user to reload their tab** (Cmd+R). An open tab reconnects by itself with the *old* wasm still in
   memory, so it logs one `hello.rejected` right after the restart. That one is expected; a fresh load is not.
6. Update the PID in `HANDOVER.md` ("Start here", item 4).

## Look at it yourself (agent-browser)

Use `zsh -ic` and set the viewport first. Click by element ref, not by text (text selectors have silently missed the
"Go" button):

```bash
zsh -ic 'agent-browser --session look set viewport 1280 800; agent-browser --session look open http://localhost:8080/sandbox; sleep 2; agent-browser --session look snapshot -i | grep -E "textbox|\"Go\"|\"Water\""'
# then: fill @<textbox-ref> "Check"; click @<go-ref>; click @<material-ref>
# paint: mouse move X Y; mouse down; (move a little, sleep); mouse up
# screenshot /tmp/<name>.png, then Read the png and look at it; close the session when done
```

The 512 x 512 sandbox canvas sits at about x 383-897, y 77-591 at 1280 x 800 (one cell is about one pixel). The
brush slider is the page's `input[type=range]` (max 32).

## Your own check server: never the user's

For an agent's own look, use a **different port and data dir**, so the user's world and tab are never touched:

```bash
mkdir -p /tmp/simulta-<name>
(PORT=8099 DATA_DIR=/tmp/simulta-<name> node server/main.ts > /tmp/<name>-server.log 2>&1 &)
```

When finished: `kill` it by its literal PID (from `lsof -ti tcp:8099 -sTCP:LISTEN`), close every agent-browser
session, and remove the data dir by its literal absolute path (`rm -rf /tmp/simulta-<name>` with the name written out,
never a variable or glob). Workers leave vite and servers running: check `pgrep -fl "vite.js|server/main"` after any
delegated task.

## Other entry points

- `pnpm dev:client` (vite, **5173**) runs a local world with no server: `/game?world=game&avatar=1&cfg=survival` gives
  a dev avatar and the `__dev*` hooks. It rebuilds the wasm, so restart the :8080 server afterwards if it is running.
- A real room on a check server: `POST /api/rooms` (base64 config from `shared/room.ts` `encodeConfig`), then set
  `localStorage` `sand.name` and `sand.token` and open `/r/<code>`.

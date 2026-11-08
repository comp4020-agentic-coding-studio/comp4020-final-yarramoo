# Brief: chat client UI (Track E, branch `chat`)

Worker: **Sonnet**, one worker, no dispatching of your own. **Cap: $5** of spend. Work in `/tmp/wt-chat` only (a git
worktree on branch `chat`). Never touch `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo` (the main
checkout) or the user's server on :8080. Never push, never merge. Read `CLAUDE.md` first: it binds you.

## What is already done (by the lead, do not change the contract)
- `shared/protocol.ts`: `C_CHAT` (`encodeChat(text)`, client to server) and `S_CHAT` (`decodeServer` gives
  `{ t: "chat", name, text, history }`). `MAX_CHAT_CHARS = 120` (characters after trim), `MAX_CHAT_BYTES = 240`
  (UTF-8 bytes; `encodeChat` throws above it or on empty), `chatHasControl(text)`.
- `server/world.ts` `onChat`: relays to every member including the sender (so the sender sees its own line come
  back: **do not echo locally**, or it shows twice), refuses anonymous, control chars, over-long; 5 lines / 10 s per
  player; late joiners get up to 20 lines from the last 10 min with `history: true`.
- `client/chat.ts`: `renderChatLine(document, from, text, myName)` returns the line element (textContent only, the
  viewer's `@mention` in `<b>`, class `mention` on the line). **Use it; do not build lines any other way, and never
  use innerHTML for chat.**
- Tests in `tests/net/chat.test.ts` (do not weaken them).

## Your job (files you may touch: `client/worker.ts`, `client/protocol.ts`, `client/room.ts`, `client/index.html`, and this brief's report)
1. **Worker** (`client/worker.ts`, `client/protocol.ts`): the worker owns the socket.
   - On `case "chat"` from the server, `send({ type: "chat", name: m.name, text: m.text, history: m.history })` to the
     main thread (add that variant to `FromWorker`).
   - Add a `ToWorker` `{ type: "chat"; text: string }`: if `ws` is open, `ws.send(encodeChat(text))` inside a
     try/catch (encodeChat throws on empty/oversized; drop silently). Chat must **never** go near `push_input`, the
     lockstep or `localSim` (invariant 1). In a local (`m.local`, no socket) room do nothing.
   - The main thread needs the viewer's own plain name to match mentions. It already has it (the `name` passed to the
     worker in `start(token, name)` in `room.ts`); keep it in a variable in `room.ts`. Spectators without a token
     have `""` and so never see bold.
2. **Panel** (`client/room.ts`, CSS in `client/index.html` next to `#toasts`): a `#chat` panel bottom-left of the
   stage, above the HUD bars (look at `#hud` and `#toasts` CSS for the placement idiom; it must not cover the spell
   bar or the health/levitate bars). `aria-live="polite"`, `pointer-events: none` on the log. Each incoming line:
   `renderChatLine(document, m.name, m.text, myName)`; keep at most 8 lines; each line fades after ~12 s like the
   toasts (`fade` class then remove). History lines (`history: true`) fade sooner (~6 s) and look dimmer. A
   `.mention` line gets a subtle highlight (e.g. a gold left border) in addition to the bold.
   Only avatar rooms and the sandbox both get chat? **Yes: every networked room** (sandbox, game, Survival, owned
   rooms). Not the local dev route (`localKind !== null`) and not the menu backdrop.
3. **Input** (desktop only: skip creating the input when `matchMedia("(pointer: coarse)").matches`; phones are
   read-only):
   - `/` opens a one-line `<input id="chat-input" maxlength="120">` just under the log, when no other input/textarea
     has focus (`e.target` is not an `HTMLInputElement`/`HTMLTextAreaElement`, no ctrl/meta/alt). `preventDefault` so
     the `/` is not typed into the box.
   - While it has focus, game keys must not fire: the existing keydown handlers return early on
     `e.target instanceof HTMLInputElement` (check **each** `addEventListener("keydown"` in `room.ts` does; there are
     several, e.g. the `r` ready toggle and the movement handler; also the `keyup` handler must not add held keys).
     When the input opens, clear `held` and call `sendKeys()` if steering (as the `blur` handler does) so the avatar
     does not keep walking.
   - Enter: trim; if non-empty, `send({ type: "chat", text })`; clear and close. Escape: clear and close. Blur:
     close. Closing returns focus to the page (`input.blur()`), so keys work again.
   - A hint: placeholder `Say something (Enter to send, Esc to close)`. Also add `/ chat` to any existing key-help
     text if there is one (grep `"O "` or `overview` in room.ts/index.html for a help line; skip if none).
   - Count with `Array.from(text).length` against `MAX_CHAT_CHARS` before sending; the server checks anyway.
4. Players only ever see plain names (CLAUDE.md): use `m.name` as given; never add ids.

## Verify
- `pnpm typecheck > /tmp/chat-w-tsc.log 2>&1 && echo ok` (exit code, never piped).
- `pnpm vitest run --config vitest.net.config.ts tests/net/chat.test.ts tests/net/imports.test.ts > /tmp/chat-w-net.log 2>&1; echo $?`
  Before running anything, check `uptime` and `pgrep -fl "cargo test|vitest|test:determinism|tests/soak"`: if another
  gate is running, wait (sleep in a loop through Monitor, or poll every 60 s) until quiet. One test run at a time.
- Do **not** run the full gate or build the client; do not start servers or browsers: the lead does the two-browser
  check.

## Commit checklist (each a separate commit, gated: `pnpm typecheck > /tmp/chat-w-tsc.log 2>&1 && git add <files by name> && git commit -q -F <msgfile>`)
- [ ] Worker relay both ways + the `FromWorker`/`ToWorker` variants.
- [ ] The panel (rendering incoming lines, CSS).
- [ ] The `/` input, key isolation, Enter/Escape/blur.
- [ ] Your report.
Each message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never commit a red typecheck.

## Rules
- Every `rm` names an explicit literal absolute path (no variables, no globs on variables, no relative paths).
- No `console.*` noise beyond what exists. No new dependencies.
- Write your report **as you go** to `/tmp/wt-chat/docs/research/chat-client-report.md`: what you changed (file:line),
  how you verified (log paths, exit codes), anything you could not do, ideas for FUTURE.md, and a section
  **"Architectural decisions for review"**: each choice later work builds on (what, alternatives, why, cost later).
  When unsure about a hard-to-reverse choice, take the more reversible option and flag it.

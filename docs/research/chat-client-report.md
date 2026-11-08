# Chat client report (Track E)

## Changes
- client/worker.ts: `case "chat"` server relay to main; `ToWorker` `chat` sends `encodeChat` in try/catch, only if ws open (no push_input/lockstep).
- client/protocol.ts: `chat` variants in ToWorker and FromWorker.
- client/room.ts: `#chat` panel, `addChat` (renderChatLine, max 8, 12 s fade, history 6 s and `.hist`), `myName` set in `start()`, `/` input (desktop, non-coarse, networked only), Enter/Esc/blur; Shift keydown handler now ignores input targets.
- client/index.html: CSS for #chat, #chat-log, #chat-input, `.mention` gold border.

## Verification
- `pnpm typecheck` exit 0 before each commit (/tmp/chat-w-tsc.log).
- `tests/net/chat.test.ts`: exit 1 (/tmp/chat-w-net.log), ENOENT sim.wasm: the worktree has no built wasm and a gate was running on the main checkout, so I did not build. imports.test.ts passed. Not browser-checked.

## Not done
- No key-help line exists, so no `/ chat` text added.

## Architectural decisions for review
- Panel is created in room.ts beside toasts; `myName` is the name passed to start() (name chosen at join), reversible.
- Single capture-less global `/` listener; focus isolation relies on existing handlers' `e.target instanceof HTMLInputElement` guards (the r-ready and main movement ones already had it; I added it to the Shift handler). The keyup handler may still delete held keys, which is harmless.
- Blur closes the input and discards the draft (per brief).

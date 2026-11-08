# Brief: cold review of the chat server side (branch `chat`)

Worker: **Sonnet**, read-only review, no dispatching. **Cap: $3.** Work in `/tmp/wt-chat` only; never edit code, never
commit, never touch the main checkout or :8080; run nothing heavier than `git` and `grep` (no tests, builds, servers).
The only file you write is `/tmp/wt-chat/docs/research/review-chat.md`, written as you go (one finding at a time).

Read `CLAUDE.md` ("Server logging and identity", invariants 1 and 9). Then read the diff cold:
`git -C /tmp/wt-chat diff multa...chat -- server/ shared/ tests/net/chat.test.ts tests/net/helpers.ts`.

Look for real defects in: rate limiting (can one member or one person flood a room; per-connection vs per-player;
memory growth of `chatWindows`/`chatHistory`; reconnect and spectator paths; the `MAX_FRAME_BYTES` 256 cap vs
`MAX_CHAT_BYTES`), input checks (control/bidi/zero-width characters, length by characters vs bytes, trimming,
invalid UTF-8, a name with odd characters), logging (is a message body ever logged or sent to the public dashboard
or `/api/summary`; is everything a client can trigger repeatedly behind `log.limited`; event names in
`shared/events.ts`), identity (is `name#id` ever sent to a player; can a client choose the sender name), the
lockstep (does chat touch the clock, the tick log, holds, or `stamp`; can a chat frame affect `heard`/liveness
in a harmful way), protocol (decoder robustness, the v10 bump), room lifecycle (reset, unload, an owned room
reloading), and anything the tests claim but do not check.

For each finding: severity (high/medium/low/nit), file:line, what is wrong, a concrete scenario, and a suggested fix.
Say plainly when an area is fine. Every `rm` (you should need none) names a literal absolute path. End your reply
with a one-paragraph summary.

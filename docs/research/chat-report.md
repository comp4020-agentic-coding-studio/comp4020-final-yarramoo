# Chat (Track E): lead report

Lead: Opus, branch `chat`, worktree `/tmp/wt-chat`, 8 Nov 2026. Cap $20; B0 = $371.93 (stop dispatching at $387.93,
finish by $391.93).

## What was built
- **Protocol** (`shared/protocol.ts`): `C_CHAT = 0x0a` (`text utf8`, at most `MAX_CHAT_BYTES = 240` so it fits the
  server's 256-byte small-frame cap) and `S_CHAT = 0x8b` (`flags u8, name_len u8, name utf8, text utf8`; flag bit 0
  is "history"). `chatHasControl` uses the same character class `cleanName` strips. Decoders return null on hostile
  bytes. `PROTOCOL_VERSION` stays 9: both frames are new tags, and an old client never sends `C_CHAT`; an old client
  that *receives* `S_CHAT` would fail `decodeServer` and close its socket (see decisions).
- **Server** (`server/world.ts` `onChat`, dispatched from `server/main.ts`): never stamped, never touches the clock
  or the log (invariant 1). Registered visitors only (anonymous refused; a registered spectator may chat). Refuses
  control/bidi/zero-width characters, trims, caps at `MAX_CHAT_CHARS = 120` characters. **5 lines per 10 s per
  registered player**, keyed on the visitor id so a reconnect does not refill it. Relays to every member including
  the sender (the client does not echo locally). **The body is never logged**: refusals log
  `input.rejected` with `reason: chat_<why>` and `input.rate_limited` with `what: "chat"`, both through `log.limited`;
  accepted lines are counted into `input.summary` as `chats`. No new event names were needed.
- **History** for late joiners: the last 20 lines from the last 10 minutes, in memory only, sent after the names at
  join with the history flag; lost on unload/restart and cleared by `reset()`.
- **Client** (`client/chat.ts`, pure, by the lead): `chatSegments`/`mentions` (the mention matcher: `@` + the viewer's
  plain name, case-insensitive, not followed by a letter/digit/underscore) and `renderChatLine` (textContent only; the
  viewer's `@mention` in `<b>`, the line gets class `mention`). **Panel and input** (Sonnet worker, brief
  `docs/briefs/chat-client.md`, report `docs/research/chat-client-report.md`): `client/worker.ts` forwards `S_CHAT` to
  the main thread and sends `C_CHAT` (never near `push_input`); `client/room.ts` `#chat` panel bottom-left above the
  Levitate bar, 8 lines, 12 s fade (history 6 s, dimmed), gold left border on a line that mentions you; `/` opens a
  one-line input on desktop only (phones read-only), Enter sends, Escape and blur close; opening it clears held keys.
  The lead added `preventDefault` on Enter/Escape (the menu router's Escape-to-Back skips a handled key).
- **Review fix**: `chatHasControl` refuses every `\p{Cf}` format character, `chatIsBlank` refuses whitespace/filler-only
  lines (review L1).
- **Protocol v10** (`7ff77eb`): see decision 3.

## Decisions recorded (the brief asked: history, spectators, Survival)
- **History**: a short ring (20 lines / 10 min), memory only. Alternatives: nothing (a joiner arrives mid-conversation
  with no context) or persisted (a database table of message bodies: a privacy and moderation surface for no gain).
- **Spectators**: may read always; may write if registered (they hold a token: the menu registers everyone who picks a
  name). Anonymous connections (no token, e.g. the CI spec clients, an unregistered sandbox painter) read only.
- **Survival rounds**: chat works the same in the lobby, during a round and after it ends (dead players and
  late-joining spectators talk too). No team or dead-only channel: one room, one chat. The ended-round room still
  relays.
- **Sandbox**: chat works there too (every networked room), with the sender's registered display name.

## Commits (branch `chat`)
| Commit | Writer | What |
|---|---|---|
| `e24794f` | Opus | frames, `World.onChat`, history, counts, matcher/renderer, tests, client brief |
| `bc113b3`, `c06bb4e`, `e1e8a81`, `c072179` | Sonnet | worker relay, panel, `/` input, worker report |
| `7ff77eb` | Opus | protocol v10 + the four version pins |
| `c47d274` | Opus | late-joiner test moved to the sandbox; Enter/Escape preventDefault |
| `a3be976` | Opus (+ Sonnet review) | `\p{Cf}` and blank refusal, review + response |

The first commits were made on a green typecheck only, while the session model's gate held the machine; the full
gate below covers everything on the branch.

## Tests and red-first evidence
`tests/net/chat.test.ts` (14 tests): relay with plain name and no body in the log; spectator chat (registered yes,
anonymous no); control/length/trim refusals; invisible lines; per-player rate limit surviving a reconnect; late-joiner
history (capped, flagged; in the sandbox); `input.summary` counts; C_CHAT/S_CHAT layouts and hostile bytes; the mention
matcher (case, word boundary, spaces, non-ASCII); markup rendered as text; bold only for the mentioned viewer.
- **Red**: with each guard broken at once (anonymous check, control check, length cap, rate limit, history send, body
  logged instead of counted, the matcher's word boundary, `innerHTML` in the renderer) all 11 behavioural tests failed,
  each on its own assertion (`/tmp/chat-red.log`; e.g. the relay test: "expected log not to contain
  'secret-body-xyz'"). Files restored from copies, `git diff` clean.
- **Red** for the review fix: the invisible-lines test against the old class and `!text` check relayed all six lines
  (`/tmp/chat-red3.log`).
- Green: `/tmp/chat-net5.log` (14/14), `/tmp/chat-net3.log` (chat + protocol + imports, 29/29).
- One test was rewritten, not weakened: the late joiner with six game-world clients timed out at 120 s (six in-process
  512x... game sims); it now runs in the sandbox, which also covers chat there.

## Gate
**Full tier** (`node scripts/gate-plan.ts`: full because `client/protocol.ts`, `client/worker.ts`, `shared/protocol.ts`),
run on a quiet host (load about 3) at `a3be976`, `gate exit 0`:
cargo test (53 binaries ok, `/tmp/chat-g-cargo.log`), clippy (`/tmp/chat-g-clippy.log`), typecheck
(`/tmp/chat-g-tsc.log`), determinism **53/53** (`/tmp/chat-g-det.log`), net **530/530** (`/tmp/chat-g-net.log`).
`pnpm check` against my own server was not run separately: the net suite covers the server, and CI's `pnpm check`
is a subset of it.

## Two browsers in a real room
Playwright, two Chromium contexts (Ana, Bo registered over `POST /api/players`), a Survival room on my own server
(:8079, `/tmp/chat-data`), script `/tmp/chat-pw/two.mjs`. Ana pressed `/` (the input appeared), typed
`hi @bo, <b>not bold</b> <img src=x onerror=alert(1)>`, Enter; then a second line; Bo pressed `/`, typed, Escape.
- Ana's DOM: both lines, no `<b>`, no `<img>`, no `mention` class. Bo's DOM: the same text, `<b>@bo</b>`, `mention`.
- The input hid after Enter and after Escape; the Escaped line was never sent; Escape did not navigate (URL unchanged).
- A third player, Cy, joined later and got both lines flagged `hist`.
- Screenshots read: `/tmp/chat-shot-bo.png` (bold **@bo** with the gold border, literal `<b>` and `<img ...>` text),
  `/tmp/chat-shot-ana.png` (same lines, nothing bold), `/tmp/chat-shot-cy.png`. The panel sits above the Levitate bar
  and left of the spell bar without overlapping them at 1280x800.

## Cold review
`docs/research/review-chat.md` (Sonnet, read-only, brief `docs/briefs/chat-review.md`): no high or medium findings.
L1 (invisible characters) confirmed and fixed red-first; L2-L4 and the nits checked in code and left with reasons
(the response is at the end of the review file).

## Architectural decisions for review
0. **Protocol v10.** Bumped (decision 3 below explains why). The session model should add one line to ARCHITECTURE.md's
   protocol list if it enumerates frames (I did not edit it: out of my file list).
1. **Rate limit keyed on the visitor id, per world** (not per connection, not global). A reconnect cannot reset it;
   two rooms each get their own budget. Cost later: none; a global per-player limit would need main.ts state.
2. **Sender echoed by the server, not locally.** The sender's own line shows only when the server accepted it, so a
   refused line (rate, control chars) silently does not appear. Alternative: local echo plus a refusal frame. Cost:
   one round trip of latency on your own line; no refusal feedback to the sender (see FUTURE).
3. **Protocol bumped to v10.** A v9 tab's `decodeServer` returns null on the unknown `S_CHAT` tag and closes the
   socket, then reconnects (still old code) and is closed again by the next line. If the sim did not change in a
   deploy, the wasm-hash check would not catch it. v10 refuses an old tab once, with "new version, reload". Cost: four
   `toBe(9)` pins moved; no other effect.
5. **Key isolation by convention**: every room `keydown` handler returns early on an input target (checked: ready `r`,
   movement/spells, Shift, and now `/`); a future handler must carry the same guard. A central focus gate would be
   sturdier; not worth it today.
6. **The refusal class blocks ZWJ emoji** (family emoji, tag flags) because `\p{Cf}` includes U+200D. Chosen over
   allowing an invisible-text channel; reversible by allowing U+200D between two emoji.
7. **The viewer's own name for mentions** is the name the room page started with (`start(token, name)`), i.e. the
   registered display name; an anonymous spectator has `""` and never sees bold.
4. **History in World memory**, not the DB: an unload loses it (an owned sandbox unloads when empty).

## D-row draft
D-2xx: In-room chat (Track E). `/` opens a one-line input on desktop; lines are server-relayed beside the lockstep
(`C_CHAT`/`S_CHAT`), never a sim input. Registered visitors only (spectators included), 120 characters, no control
characters, 5 lines/10 s per player, the body never logged (counts in `input.summary`). Late joiners get the last 20
lines from 10 min (memory only). `@name` is matched on the viewer's side and bolded only on that viewer's screen.

## Engineering-decisions entry draft
Probably not warranted on its own (no structural change to the lockstep). If the session model wants one: "Chat is the
second server-relayed channel beside the lockstep (after names and achievements): it never reaches the sim, so it
needs none of the determinism machinery, but it is the first one carrying player-written text, so the work went into
the trust edge: per-player rate limit keyed on the registration, a refusal class covering every format character, the
body never logged, and render by textContent with the mention decided on the viewer's side."

## FUTURE ideas (listed, not added)
- A per-IP chat cap on top of the per-player one (review L4), if many-token abuse ever shows up.
- A sliding window instead of the fixed one (review L3).
- A refusal frame so the sender sees "slow down" or "too long" instead of a silent drop.
- Phone input (a chat button opening the same input).
- Mute a player (client-side ignore list by name).
- Highlight-only notification sound on a mention (ties to Track D sound).

## Spend
B0 $371.93. Client worker (Sonnet) about $3-4 (the reading after it was $375.89, including my own calls meanwhile);
review worker (Sonnet) under $1. Total at report time: **$379.78, $7.85 of the $20 cap**.

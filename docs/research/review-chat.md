# Review: chat server side (branch chat)

No high or medium findings. Read: diff of server/, shared/ (world.ts onChat, main.ts dispatch, protocol.ts codecs, stats.ts).

- low, shared/protocol.ts:389 (chatHasControl) and shared/protocol.ts:365 (cleanName): the deny class omits U+2060 word joiner, U+FEFF, U+061C, U+180E, U+3164 (Hangul filler) and U+00AD-like invisibles. Scenario: a line of only U+3164 passes trim (not whitespace to JS trim) and relays as an invisible message; same hole lets a name look empty. Fix: add those code points (or test with \p{Cf}) and reject lines with no visible char.
- low, server/world.ts:803: sweep of expired chatWindows runs only on an accepted line, after the rate return. Map is bounded by distinct visitors per room and cleared on reset, so growth is small; fine in practice. Optionally sweep before the rate check.
- low, server/world.ts:792: fixed window allows 5 lines at the end of one window plus 5 at the start of the next (10 in a moment). Acceptable; fix only if it matters (token bucket).
- low, server/world.ts:786-792: limit is per visitorId, per room. A person who can register many visitor ids (check the registration limit) multiplies the rate; per-IP not applied. Not a defect if registration is throttled.
- nit, server/main.ts:1479: heard() runs for every chat frame, so a live member that sends one chat line each few seconds but nothing else stays "alive" (world.ts:922). Ping/hash are required anyway for stamping, and a never-live member is still capped by catchupSince, so harm is minimal.
- nit, server/world.ts:726: history is replayed to a joiner after the welcome, before it is live; a catching-up client must accept S_CHAT mid-replay (client change, not checked here).
- nit, shared/protocol.ts:620: S_CHAT decode bounds name by MAX_NAME_CHARS*4 bytes but the server cleans to MAX_NAME_CHARS chars, so consistent; name_len is u8 and fits.

Areas that are fine:
- Frame cap: C_CHAT max 241 bytes < MAX_FRAME_BYTES 256; decoder enforces 1+MAX_CHAT_BYTES, so encodeChatLine cannot throw on a decoded line (trim only shrinks). Invalid UTF-8 -> fatal decoder -> null -> close 1002.
- Length checked in characters (Array.from, 120) after the byte cap (240); trimming after the control check is fine.
- Logging: body never logged; refusals use log.limited-style elog.limited keyed per conn / per visitor; event names input.rejected and input.rate_limited exist in shared/events.ts; accepted lines only increment counts.chats into input.summary. No body on dashboard or /api/summary.
- Identity: sender name comes from server-held m.visitorName, never from the frame; name#id only used in logs via whoOf.
- Lockstep: onChat touches neither clock, log, holds nor stamp; dispatch is before the sim-input paths. Reset clears chatHistory/chatWindows and onChat refuses while resetting. History is memory-only (lost on unload, documented).
- Protocol: v10 bump rationale is sound; existing tests bumped.

Test gaps: no test that chat leaves the tick log/clock untouched; no test for invisible-character lines (finding 1); no test that a replaced (stale) connection's chat is ignored (main.ts hasMember guard covers it by code).

Summary: the server side is sound. The only real gap is the invisible-character deny list (low); rate limiting is per player, memory is bounded, nothing logs bodies, identity is server-derived, and the lockstep is untouched.

---

## Lead's response (Opus, checked against the code)

- **L1 invisible characters: confirmed and fixed.** `chatHasControl` now refuses all of `\p{Cf}` (U+2060, U+FEFF,
  U+061C, U+180E, bidi, zero-widths) plus C0/C1 controls and line separators; new `chatIsBlank` refuses a line of only
  whitespace and blank-looking fillers (U+115F, U+1160, U+3164, U+FFA0, U+2800). New test "refuses invisible lines",
  shown red against the old class and blank check (`/tmp/chat-red3.log`: all six invisible lines relayed), green
  after. Found while writing it: a *leading* U+FEFF never reaches the server, because `TextDecoder` drops a BOM, so
  it arrives as plain text; harmless, and the test says so. Cost: ZWJ emoji sequences and tag-flag emoji are now
  refused (recorded in the doc comment).
- **L2 sweep only on accepted lines:** true (`world.ts` sweep after the rate check). Bounded by visitors per room and
  cleared on reset and on unload (the World is discarded). Left as is.
- **L3 fixed window allows 10 at a boundary:** true; acceptable for chat (still bounded, 10 lines per ~10 s). Left.
- **L4 no per-IP cap:** true. Registration (`POST /api/players`) is the throttle the claims path already relies on
  (D-119); a person with many tokens also needs many connections, which the member caps bound. Left; listed in FUTURE.
- **N1 chat keeps a member "heard":** true and intended: chat is traffic from a live socket. A member still has to
  send HASH/LIVE to vote or leave catch-up; liveness only decides when a silent socket is dropped. Left.
- **N2 history before LIVE:** checked in the client: `worker.ts` forwards `S_CHAT` in any state (the `chat` case does
  not need `ls`), and the two-browser run showed a late joiner receiving it (Cy, history-dimmed).

# S5 Crew profiles

**Pages**: `GET /crew/:callsign` (header, flown count by outcome, top seats, the record with a plain-language verdict, up to 30 flown missions, attribution note; 404 if unknown, case-insensitive) and `GET /crew?sort=flown|spoke|caution` (100 rows, garbage falls back to flown). Nav gains "Crew". Callsigns link to profiles in the header, lobby seats (server render and console.js), replay crew list and poll table, missions list, agency ledger. `callsignLink` lives in layout.ts.

**Attribution/counting**: src/game/records.ts. One SQL joins `mission_events(kind='poll_report')` to done missions and to `seats` on (mission, role), grouping by (crew, mission) using `json_extract` on `showing`/`report`. Every report counts, re-polls included. GO on caution = go+caution; spoke up = nogo+caution. Done missions only. Profile is 2 queries, index is 2; no N+1.

**Tests**: spec/crew.test.ts (4 tests): zero-flown/404/case/odd path, scrubbed mission flown + linked and live absent, index listing once and sort fallback, text rendering. `pnpm check` green (148 tests); typecheck clean. Spec cannot reach polls (scrub only), so I inserted synthetic poll_report rows into a scratch DB and confirmed 2 cautions / 1 spoke / 1 GO-on-caution.

**Browser**: 390 px profile and /crew, no horizontal scroll; screenshot plans/reports/S5-crew.png.

**Weak spots**: no spec test with real poll data (needs a full flight); `getSequence` throws if a stored sequence id is retired; index aggregates all missions on each request (fine at this scale, unindexed).

**FUTURE.md**: a "spoke up" streak or badge; per-crew trend over time; crew compare page.

## Session review

Checked with real data, not only synthetic rows: a two-browser "reckless crew"
mission (fix steps skipped, GO always) exploded at T-0. wren (Propulsion)
shows "Said GO on a caution 2 times out of 2 cautions"; kestrel (Ground) shows
the same, which is right since phase 6: Ground's cross-check read ABNORMAL for
the real vent fault, so Ground had the evidence too.

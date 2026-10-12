# 07 Agency (D3: one shared agency)

**Schema** (`002_agency.sql`): `agency` (single row 1000/50), `pads` (LC-1), `rockets` (K1-01..03), `missions.rocket_id/pad_id`, `agency_ledger`.

**Rules** (`agency-rules.ts`, pure, one `RULES` table): success +300/+5, rocket -10, flight +1, pad -5; pad_abort -100/-2, rocket -40 and repair, pad -10; explosion -400/-15, rocket lost, pad -60; scrub -50/0, lost contact -3 rep. Each GO on caution -3, each NO-GO on caution +2. Clamps: conditions and reputation 0-100, budget floor 0 (noted in the ledger reason). Costs: pad 10/point, rocket repair 200, buy 500.

**Done hook**: `rooms.ts commit()` calls `applyOutcome` inside the existing `tx` that marks the mission done, reading poll reports (all rounds) from the final state. The UPDATE is guarded by `status != 'done'`, so it applies once. `publishAgency()` fires after commit.

**Start gate**: `claimForStart` runs before the engine, re-checks the rocket (reassigns if flown or lost, or held by another live mission) and pad >= 40%. The lobby shows rocket, pad and the block reason.

**Concurrency**: repairs and buys are single transactions. `spend()` is a conditional `UPDATE ... budget >= ?` plus a `changes` check. Rocket and pad repairs are also conditional on prior status or condition, so there is no double repair or overspend. A refusal throws and rolls back.

**Verified**: typecheck, engine tests (75), `pnpm check` green on a temp-data server (91 tests). In the browser (g1 on /agency, g2 seated all roles, started and scrubbed via fetch), g1's page showed budget 550 with no reload. Screenshot `07-agency.png`.

**Weak spots**
- Tests run in parallel against a shared budget, so assertions are per mission code. The pad-repair test skips itself if another file damaged the pad.
- The buy-rocket unaffordable path is not spec-tested.
- Rocket assignment prefers rockets not held by an unfinished mission (a small deviation from "lowest id").
- `agency.js` defers its refresh while a form is focused.
- Flash messages travel in the query string (escaped, truncated).
- Pad condition is not reserved, so two live missions can share it.

**FUTURE.md suggestions**: agency history chart (budget and reputation over time); per-callsign "speaks up" leaderboard; pad auto-repair over time; a fixed seeded agency for tests.

## Session review

Found in review: the shared agency could die for good. Two explosions leave
the pad under 40% with the budget near zero; nothing can be repaired, nothing
can launch, and launching is the only income. Added an emergency
appropriation: when the agency is grounded and cannot afford to fly again, any
crew member can request exactly the shortfall, for -10 reputation, once per
grounding (the check runs inside the transaction). Verified by grounding a
temp agency (pad 20%, budget 100): the Agency page offered 700 credits; two
simultaneous requests gave one grant and one refusal.

Note: the spec suite assumes the shared agency can launch. Against a
deliberately grounded database, the mission tests fail. CI always starts from
a fresh /data, so this holds there; never point `pnpm check` at production.

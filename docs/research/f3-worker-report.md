# F3 worker report: new spells

## Commits (none pushed)
1. Scaffolding: NUM_SPELLS 12 (Teleport, id 12, not built yet), arrays, `BAG_SPELL_IDS`, snapshot v6, TS names/table/BAR, inputgen casts 0..11. Spells 7-11 start disabled in `SPELL_ENABLED`. Gate: cargo test, clippy, typecheck, test:determinism (41) green. Red first: `every_finite_spell_round_trips...` fails with the old bag table (ids repeated).

## Architectural decisions for review
- Bag: table `BAG_SPELL_IDS` (9 finite spells) mapping bag index to spell id; BAG_BYTES 26. Alternative: carry all 12 slots (wastes 6 bytes per bag, simpler). Cost: adding a finite spell means editing the table (a test pins it to START_CHARGES).

# Boss budget: is 800 hp right for a two-player party?

Measured by `sim/examples/boss_budget.rs` (`cargo run --release --example boss_budget`), Survival worlds, sizes S, M, L, seeds 1 to 10. Numbers come from `tuning.rs`: Fire bolt 20 per hit, 10 charges per pickup; Bomb at most 60 at the centre (falls off linearly to 0 at radius 18), 5 charges per pickup; Blast 8 per hit at a 90-tick cooldown, so 5.33 damage a second and infinite; heal drop 1 in 3 kills, 25 hp (D-181). "Damage" below means the **ceiling at 100% accuracy** with every Bomb a dead-centre hit.

## Table (means over 10 seeds; per-seed rows are in the tool's output)
| size | Fire+Bomb above the arena | supply pile | total | enemies passed (hp) | heals expected (hp) |
|---|---|---|---|---|---|
| S | 860 (range 200 to 1200) | 1400 | 2260 | 15.8 (676) | 5.3 (132) |
| M | 1040 (range 500 to 1500) | 1400 | 2440 | 17.0 (700) | 5.7 (142) |
| L | 3190 (range 1700 to 3800) | 1400 | 4590 | 51.0 (2060) | 17.0 (425) |

The pile is the same everywhere: 4 Fire pickups (40 charges, 800 damage) and 2 Bomb pickups (10 charges, 600 damage at best). Enemy counts exclude the boss and are all above the arena (the arena keep-out has none). In S seed 3 the tool counts a 5th Fire pickup as pile (1600): a randomly placed pickup on the arena floor row beyond the pile start; I did not check it further, and it is immaterial to the reading. Enemy counts barely vary by seed.

## Reading
What a party brings to the boss (damage x accuracy), if it collects everything above and uses the pile:
| accuracy | S total | M total | L total | pile alone | pile alone, Fire only |
|---|---|---|---|---|---|
| 50% | 1130 | 1220 | 2295 | 700 | 400 |
| 30% | 680 | 730 | 1380 | 420 | 240 |

- **Pile alone does not suffice** at 50% (700 against 800) and clearly not at 30% (420), and at 100% only if every Bomb is a perfect centre hit. Bomb damage is optimistic: a Bomb hitting off-centre does about half, so a realistic pile is nearer 1100 at 100%, 550 at 50%. This matches the earlier bot runs in `hb-boss-win.md` (400 to 650 damage dealt, no win).
- **A party that collects everything** clears 800 at 50% in all three sizes, and at 30% only at L (1380); at S and M it falls just short at 30% (680 to 730). But "collects everything" is a ceiling: that ammunition is spread across the whole map, and a party also spends charges on the 16 to 51 enemies on the way (676 to 2060 hp of them; Blast can kill those for free but slowly, 5.3 damage a second). At L the surplus is large (about 1500 spare at 50%), so L is not the problem. S and M are tight.
- Charges are per player, so the pile's 1400 is split between two people; one dying with charges in hand loses them (bags aside).
- Heals (132 to 425 hp across the walk) help survival, not damage; the boss kills in about 5 s of standing still, so heals do not change the ammunition picture.
- Blast alone: 800 hp at 5.33 damage a second is 150 s of uninterrupted hits with 100% accuracy, which is not an option against a boss that shoots every second.

## BOSS_HP so the pile alone suffices at 50% accuracy
- Counting Fire plus perfect Bombs: **700 hp** (1400 x 0.5).
- Counting Fire plus realistic Bombs (about half of 60 average): about 550 hp (1100 x 0.5).
- Counting Fire only: 400 hp.
So 800 is roughly 15% above what the pile can do at 50% in the most generous reading, and well above it in realistic ones.

## Recommendation (the decision is the user's)
The 800 hp number is only a problem if the pile is meant to be enough; at 50% a party that skipped the dive's pickups cannot win. I would pick one of:
1. **Lower BOSS_HP to 600** (my recommendation). The pile alone then needs about 43% accuracy at the ceiling, a party with a few pickups from the way down has slack, and S/M parties at 30% accuracy who collect everything (680 to 730) clear it. It keeps the boss a real fight (about 30 Fire hits).
2. Keep 800 and **raise the pile** to 6 Fire and 3 Bomb pickups (2100 ceiling; 1050 at 50%), which keeps the boss at 800 but needs a new SUPPLY_PILE and a larger alcove (SUPPLY_ALCOVE_W is 28 cells for 6 pickups 4 apart, which would not fit nine).
3. Keep both and accept that victory requires collecting on the way down; at S and M that is a narrow margin at 30% accuracy, so I would not.
Changing either number changes the boss row of `ENEMY_STATS`, `BOSS_HP`, the client mirror and any test that pins them.

Caveats: this counts ammunition, not survival; accuracy against a dodging 11 by 14 cell target is a guess (50% and 30% as asked), not measured; Bomb damage uses the centre maximum; pickups respawn is off in Survival (`pickup_respawn: 0`), so the numbers are one-shot.

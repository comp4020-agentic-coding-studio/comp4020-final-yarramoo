//! INT-2: the boss is chosen per seed (Deep Mage or Sand Colossus), exactly one per Survival world, at any size;
//! the enemy budget holds; every generated world's snapshot round-trips through decode.
use sim::config::RoomConfig;
use sim::sim::{boss_kind, Sim};
use sim::snapshot;
use sim::tuning::*;

fn survival(size: u8, seed: u64, ) -> Sim {
    Sim::new(seed, RoomConfig { size, ..RoomConfig::survival() }).unwrap()
}

fn bosses(s: &Sim) -> Vec<u8> {
    s.enemies.iter().filter(|e| e.kind == ENEMY_BOSS || e.kind == ENEMY_COLOSSUS).map(|e| e.kind).collect()
}

#[test]
fn over_64_seeds_both_bosses_occur_and_each_world_has_exactly_one() {
    let (mut mage, mut colossus) = (Vec::new(), Vec::new());
    for seed in 1..=64u64 {
        let want = boss_kind(seed);
        // The roll is a pure function of the seed: S worlds are the cheap ones to generate.
        let s = survival(0, seed);
        assert_eq!(bosses(&s), vec![want], "seed {seed}");
        if want == ENEMY_COLOSSUS { colossus.push(seed) } else { mage.push(seed) }
    }
    std::fs::write("/tmp/int-boss-seeds.txt", format!("mage {mage:?}\ncolossus {colossus:?}\n")).unwrap();
    assert!(mage.len() >= 16 && colossus.len() >= 16, "mage {} colossus {}", mage.len(), colossus.len());
}

#[test]
fn the_choice_does_not_depend_on_size() {
    for seed in 1..=6u64 {
        for size in 0u8..=2 {
            assert_eq!(bosses(&survival(size, seed)), vec![boss_kind(seed)], "size {size} seed {seed}");
        }
    }
}

#[test]
fn the_enemy_budget_holds_and_every_world_round_trips() {
    let mut worst = 0;
    for (size, n) in [(0u8, 32u64), (1, 32), (2, 32)] {
        for seed in 1..=n {
            for cfg in [RoomConfig { size, ..RoomConfig::survival() }, RoomConfig { size, enemies: 1, ..RoomConfig::caves_pvp() }] {
                let mut s = Sim::new(seed, cfg).unwrap();
                worst = worst.max(s.enemies.len());
                assert!(s.enemies.len() <= MAX_ENEMIES, "size {size} seed {seed}: {} enemies", s.enemies.len());
                let mut r = snapshot::restore(&snapshot::write(&s)).unwrap_or_else(|_| panic!("size {size} seed {seed} does not round-trip"));
                assert_eq!(r.enemies, s.enemies);
                assert_eq!(r.state_hash(), s.state_hash());
            }
        }
    }
    assert!(worst <= MAX_ENEMIES);
}

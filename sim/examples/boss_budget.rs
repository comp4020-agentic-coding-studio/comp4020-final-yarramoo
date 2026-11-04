#![allow(clippy::disallowed_methods)] // reporting tool, not part of the sim
//! Boss ammunition budget: `cargo run --release --example boss_budget`.
//! For Survival worlds at sizes S, M, L and seeds 1..=10: the damage the pickups hold (Fire bolt and Bomb), split
//! into the supply pile beside the arena and everything above it, the enemies a party passes, and heal drops expected.
//! Fire: `FIRE_BOLT_DAMAGE` per hit. Bomb: at most `EXPLOSION_DAMAGE_MAX` at the centre (a perfect hit; real hits
//! fall off linearly to 0 at `BOMB_RADIUS`). Blast: `BLAST_ENEMY_DAMAGE` per `COOLDOWN[1]` ticks, at 60 Hz.
use sim::config::RoomConfig;
use sim::sim::Sim;
use sim::tuning::*;

type Row = (u64, i32, i32, i32, i32, i64, i64, usize, i64, f64);
const FIRE: u8 = 4;
const BOMB: u8 = 5;

fn main() {
    let fire_dmg = |sp: u8| -> i64 { i64::from(PICKUP_CHARGES[usize::from(sp)]) * i64::from(FIRE_BOLT_DAMAGE) };
    let bomb_dmg = |sp: u8| -> i64 { i64::from(PICKUP_CHARGES[usize::from(sp)]) * i64::from(EXPLOSION_DAMAGE_MAX) };
    let blast_dps = f64::from(BLAST_ENEMY_DAMAGE) * 60.0 / f64::from(COOLDOWN[1]);
    println!("Fire {} dmg x {} charges/pickup; Bomb <= {} dmg x {} charges/pickup; Blast {:.2} dmg/s (cooldown {} ticks); boss hp {}",
        FIRE_BOLT_DAMAGE, PICKUP_CHARGES[4], EXPLOSION_DAMAGE_MAX, PICKUP_CHARGES[5], blast_dps, COOLDOWN[1], BOSS_HP);
    println!("{:<4} {:>3} {:>5} {:>5} {:>6} {:>6} {:>6} {:>6} {:>6} {:>6} {:>6} {:>5}",
        "size", "n", "pFire", "pBomb", "abvDmg", "pileDm", "totDmg", "enemies", "enHP", "heals", "healHP", "pileOK");
    for (size, name) in [(0u8, "S"), (1, "M"), (2, "L")] {
        let mut rows = Vec::new();
        for seed in 1..=10u64 {
            let mut cfg = RoomConfig::survival();
            cfg.size = size;
            let s = Sim::new(seed, cfg).expect("world");
            let a = s.arena.expect("arena");
            let (mut above, mut pile) = (0i64, 0i64);
            let (mut af, mut ab, mut pf, mut pb) = (0, 0, 0, 0);
            for p in &s.pickups {
                let in_pile = i32::from(p.y) == a.floor_y - 1 && (i32::from(p.x) - a.cx) * a.side >= a.floor_half_width() + 6;
                let (f, b) = (if p.spell == FIRE { fire_dmg(p.spell) } else { 0 }, if p.spell == BOMB { bomb_dmg(p.spell) } else { 0 });
                if in_pile {
                    pile += f + b;
                    pf += i32::from(p.spell == FIRE);
                    pb += i32::from(p.spell == BOMB);
                } else {
                    above += f + b;
                    af += i32::from(p.spell == FIRE);
                    ab += i32::from(p.spell == BOMB);
                }
            }
            let en: Vec<_> = s.enemies.iter().filter(|e| e.kind != ENEMY_BOSS).collect();
            let hp: i64 = en.iter().map(|e| i64::from(e.hp)).sum();
            let heals = en.len() as f64 / f64::from(HEAL_DROP_ONE_IN);
            rows.push((seed, af, ab, pf, pb, above, pile, en.len(), hp, heals));
        }
        for r in &rows {
            let heal_hp = r.9 * f64::from(HEAL_AMOUNT);
            println!("{:<4} {:>3} {:>2}F{:>2}B {:>2}F{:>2}B {:>6} {:>6} {:>6} {:>7} {:>6} {:>6.1} {:>6.0} {:>5}",
                name, r.0, r.1, r.2, r.3, r.4, r.5, r.6, r.5 + r.6, r.7, r.8, r.9, heal_hp, if r.6 >= i64::from(BOSS_HP) { "yes" } else { "no" });
        }
        let n = rows.len() as f64;
        let m = |f: &dyn Fn(&Row) -> f64| rows.iter().map(f).sum::<f64>() / n;
        println!("{:<4} mean: above {:.0} dmg, pile {:.0} dmg, enemies {:.1} ({:.0} hp), heals {:.1} ({:.0} hp)\n",
            name, m(&|r| r.5 as f64), m(&|r| r.6 as f64), m(&|r| r.7 as f64), m(&|r| r.8 as f64), m(&|r| r.9), m(&|r| r.9 * f64::from(HEAL_AMOUNT)));
    }
}

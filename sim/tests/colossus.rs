//! X-boss: the Sand Colossus (size L Survival). Core behaviour, determinism, bounded work.
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::encode_join;
use sim::materials::*;
use sim::sim::{boss_kind, Sim};
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

fn cfg_l() -> RoomConfig {
    RoomConfig { size: 2, ..RoomConfig::survival() }
}

fn col(s: &Sim) -> &Enemy {
    s.enemies.iter().find(|e| e.kind == ENEMY_COLOSSUS).expect("a colossus")
}

fn ci(s: &Sim) -> usize {
    s.enemies.iter().position(|e| e.kind == ENEMY_COLOSSUS).unwrap()
}

/// A seed that rolls the Colossus (lowest such seed from 1), and one that rolls the Mage.
fn seed_with(kind: u8) -> u64 {
    (1u64..).find(|&s| boss_kind(s) == kind).unwrap()
}

fn fight(dx: i32) -> Sim {
    let mut s = Sim::new(seed_with(ENEMY_COLOSSUS), cfg_l()).unwrap();
    s.enemies.retain(|e| e.kind == ENEMY_COLOSSUS);
    s.push_input(&encode_join(1));
    s.step();
    s.round_running = 1;
    let a = s.arena.unwrap();
    s.players[0].x = (a.cx + dx) * PX;
    s.players[0].y = a.floor_y * PX;
    s.players[0].health = HEALTH_MAX;
    s
}

fn count(s: &Sim, m: u8) -> usize {
    s.grid.mat.iter().filter(|&&c| c == m).count()
}

#[test]
fn a_seed_rolls_the_colossus_and_the_colossus_is_one_boss() {
    let s = Sim::new(seed_with(ENEMY_COLOSSUS), cfg_l()).unwrap();
    assert_eq!(s.enemies.iter().filter(|e| e.kind == ENEMY_BOSS || e.kind == ENEMY_COLOSSUS).count(), 1);
    assert_eq!(col(&s).hp, COLOSSUS_HP);
    assert_eq!(col(&s).last_hp, COLOSSUS_HP);
    assert_eq!(ENEMY_STATS[usize::from(ENEMY_COLOSSUS)].hp, COLOSSUS_HP);
    let m = Sim::new(seed_with(ENEMY_BOSS), cfg_l()).unwrap();
    assert!(m.enemies.iter().any(|e| e.kind == ENEMY_BOSS) && !m.enemies.iter().any(|e| e.kind == ENEMY_COLOSSUS));
}

#[test]
fn a_hit_sheds_sand_beside_it() {
    let mut s = fight(60);
    for _ in 0..3 {
        s.step();
    }
    let before = count(&s, SAND);
    let i = ci(&s);
    s.damage_enemy(i, 40, 1);
    s.step();
    let shed = count(&s, SAND) - before.min(count(&s, SAND));
    assert!(shed >= 10, "shed {shed}");
    assert!(col(&s).hp <= COLOSSUS_HP - 40 + 2);
}

#[test]
fn it_reforms_by_sucking_up_nearby_sand() {
    let mut s = fight(150);
    s.step();
    let i = ci(&s);
    s.enemies[i].hp = 300;
    s.enemies[i].last_hp = 300;
    let (cx, cy) = (s.enemies[i].x >> 4, (s.enemies[i].y >> 4) - 6);
    let w = s.grid.w;
    // a pile of sand on the arena floor beside it
    for k in 0..40 {
        let idx = (cy + 5) as usize * w + (cx + 7 + (k % 8)) as usize - (k / 8) as usize * w;
        if s.grid.mat[idx] == EMPTY {
            s.grid.set(idx, SAND, 0);
        }
    }
    let sand0 = count(&s, SAND);
    for _ in 0..200 {
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    assert!(col(&s).hp > 300, "hp {}", col(&s).hp);
    assert!(count(&s, SAND) < sand0);
}

#[test]
fn it_walks_toward_a_player() {
    let mut s = fight(50);
    let x0 = col(&s).x;
    for _ in 0..120 {
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    assert!(col(&s).x > x0, "{} {}", col(&s).x, x0);
}

#[test]
fn mid_fight_snapshot_restores_to_equal_hashes_and_work_is_bounded() {
    let mut s = fight(40);
    let mut peak = 0;
    for t in 0..400 {
        if t % 40 == 20 {
            let i = ci(&s);
            s.damage_enemy(i, 30, 1);
        }
        s.step();
        peak = peak.max(s.enemy_work);
        s.players[0].health = HEALTH_MAX;
    }
    assert!(col(&s).phase >= 2);
    let mut r = snapshot::restore(&snapshot::write(&s)).unwrap();
    assert_eq!(r.enemies, s.enemies);
    for _ in 0..300 {
        s.step();
        r.step();
        s.players[0].health = HEALTH_MAX;
        r.players[0].health = HEALTH_MAX;
        assert_eq!(s.state_hash(), r.state_hash());
    }
    // work: 24 shed + 361 scan + 10 shower + collision tests of the others, far under any per-tick budget
    assert!(peak < 2500, "peak {peak}"); // measured 1909 (collision tests of integrate and step-up dominate; the Colossus own cells are under 400)
}

#[test]
fn killing_it_wins_the_round() {
    let mut s = fight(30);
    let i = ci(&s);
    s.enemies[i].hp = 1;
    s.enemies[i].last_hp = 1;
    s.damage_enemy(i, 5, 1);
    s.step();
    assert_eq!(s.boss_killed, 1);
}

/// A lethal hit must kill on every tick phase: the re-form pass (every 8th tick by id) once revived a 0-hp body.
#[test]
fn a_lethal_hit_kills_on_every_tick_phase() {
    for k in 0..8 {
        let mut s = fight(30);
        for _ in 0..k {
            s.step();
        }
        s.players[0].health = HEALTH_MAX;
        let i = ci(&s);
        s.enemies[i].hp = 1;
        s.enemies[i].last_hp = 1;
        s.damage_enemy(i, 5, 1);
        s.step();
        assert_eq!(s.boss_killed, 1, "offset {k}");
    }
}

#[test]
fn bad_colossus_records_are_refused() {
    let bad = |f: &dyn Fn(&mut Sim)| {
        let mut t = fight(30);
        f(&mut t);
        snapshot::restore(&snapshot::write(&t)).is_err()
    };
    assert!(bad(&|t| { let i = ci(t); t.enemies[i].phase = 0; }));
    assert!(bad(&|t| { let i = ci(t); t.enemies[i].last_hp = COLOSSUS_HP + 1; }));
    assert!(bad(&|t| { let i = ci(t); t.enemies[i].last_hp = 0; }));
    assert!(bad(&|t| { let i = ci(t); t.enemies[i].summons = 1; }));
    // A non-Colossus kind with a last_hp is refused too.
    assert!(bad(&|t| { let i = t.enemies.len(); t.enemies.push(Enemy::new(60000, ENEMY_SLIME, t.enemies[0].x, t.enemies[0].y)); t.enemies[i].last_hp = 5; }));
}

/// INT-2: the boss is chosen at any size, so the Colossus must fit and work in the smallest (S) arena.
#[test]
fn it_fits_and_fights_in_a_size_s_arena() {
    let seed = seed_with(ENEMY_COLOSSUS);
    let mut s = Sim::new(seed, RoomConfig { size: 0, ..RoomConfig::survival() }).unwrap();
    let a = s.arena.unwrap();
    assert!(a.floor_half_width() >= 20, "floor {}", a.floor_half_width());
    s.enemies.retain(|e| e.kind == ENEMY_COLOSSUS);
    let (cx0, cy0) = (col(&s).x >> 4, col(&s).y >> 4);
    // Its body stands in open air above the floor: no solid cell in its hit box at spawn.
    let (x0, y0, x1, y1) = col(&s).hitbox_cells();
    for y in y0..=y1 {
        for x in x0..=x1 {
            assert_eq!(s.grid.mat[y as usize * s.grid.w + x as usize], EMPTY, "solid at {x},{y}");
        }
    }
    assert_eq!((cx0, cy0), (a.cx, a.floor_y));
    s.push_input(&encode_join(1));
    s.step();
    s.round_running = 1;
    s.players[0].x = (a.cx + 18) * PX;
    s.players[0].y = a.floor_y * PX;
    for t in 0..600 {
        if t % 100 == 50 {
            let i = ci(&s);
            s.damage_enemy(i, 80, 1);
        }
        s.step();
        s.players[0].health = HEALTH_MAX;
        let c = col(&s);
        assert!(a.contains(c.x >> 4, (c.y >> 4) - 6, 0), "left the arena at tick {t}");
        assert!(c.y >> 4 <= a.floor_y + 1, "fell through the floor");
    }
    assert!(col(&s).x > cx0 * PX, "it walked toward the player");
}

/// The branch's caps: a huge hit sheds at most COLOSSUS_SHED_MAX sand cells in one tick.
#[test]
fn shedding_is_capped_per_tick() {
    let mut s = fight(60);
    for _ in 0..3 {
        s.step();
    }
    let before = count(&s, SAND);
    let i = ci(&s);
    s.damage_enemy(i, 500, 1);
    let hp = col(&s).hp;
    s.step();
    let shed = count(&s, SAND).saturating_sub(before);
    assert!(shed >= 1 && shed <= usize::from(COLOSSUS_SHED_MAX), "shed {shed}");
    assert!(hp < COLOSSUS_HP);
}

/// The shower is 10 cells at most per pass and never lethal: with 10 hp it does not fire at all.
#[test]
fn the_shower_is_ten_cells_and_never_lethal() {
    let mut s = fight(30);
    let i = ci(&s);
    s.enemies[i].hp = COLOSSUS_SHOWER_CELLS as u16; // not > cells: no shower
    s.enemies[i].last_hp = s.enemies[i].hp;
    s.enemies[i].phase = 3;
    let before = count(&s, SAND);
    for _ in 0..400 {
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    assert!(count(&s, SAND) <= before, "a shower fell from a body at {} hp", COLOSSUS_SHOWER_CELLS);
    assert!(col(&s).hp >= 1);
    // With more hp it does fall, and each pass costs exactly 10 hp and puts at most 10 sand cells.
    let mut t = fight(30);
    let j = ci(&t);
    t.enemies[j].hp = 400;
    t.enemies[j].last_hp = 400;
    t.enemies[j].phase = 3;
    let mut peak = 0usize;
    let mut prev = count(&t, SAND);
    for _ in 0..400 {
        t.step();
        t.players[0].health = HEALTH_MAX;
        let now = count(&t, SAND);
        peak = peak.max(now.saturating_sub(prev));
        prev = now;
    }
    assert!(peak >= 1 && peak <= COLOSSUS_SHOWER_CELLS as usize, "peak sand per tick {peak}");
}

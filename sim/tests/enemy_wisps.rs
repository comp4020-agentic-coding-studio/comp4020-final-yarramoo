//! X2: the Lava wisp and the Frost sprite (hunt, capped trail, immunity, placement, determinism, snapshot).
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::encode_join;
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

/// An all-Empty box x 100..700, y 100..300 with a floor, player 1 at x 600; no generated enemies.
fn open_arena() -> Sim {
    let mut s = Sim::new(5, RoomConfig::survival()).unwrap();
    s.enemies.clear();
    let w = s.grid.w;
    for m in s.grid.mat.iter_mut() {
        if matches!(*m, LAVA | ICE | ACID) {
            *m = EMPTY; // the generated world's own pools would move the global counts these tests assert on
        }
    }
    for y in 100..300 {
        for x in 100..700 {
            s.grid.mat[y * w + x] = EMPTY;
        }
    }
    for x in 100..700 {
        s.grid.mat[300 * w + x] = ROCK;
    }
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
    s.push_input(&encode_join(1));
    s.step();
    s.round_running = 1;
    s.players[0].x = 600 * PX;
    s.players[0].y = 299 * PX;
    s
}

fn keep_alive(s: &mut Sim) {
    s.players[0].health = HEALTH_MAX;
}

fn count(s: &Sim, m: u8) -> usize {
    s.grid.mat.iter().filter(|&&c| c == m).count()
}

fn spawn(s: &mut Sim, kind: u8, x: i32, y: i32) {
    s.enemies = vec![Enemy::new(0, kind, x * PX + PX / 2, y * PX)];
}

#[test]
fn a_wisp_hunts_and_leaves_a_capped_lava_trail() {
    let mut s = open_arena();
    spawn(&mut s, ENEMY_WISP, 540, 250);
    let d0 = (s.enemies[0].x - s.players[0].x).abs();
    let lava0 = count(&s, LAVA);
    for _ in 0..600 {
        s.step();
        keep_alive(&mut s);
        assert!(s.enemy_work <= 400, "bounded work");
    }
    assert!((s.enemies[0].x - s.players[0].x).abs() < d0, "it closed in");
    let lava = count(&s, LAVA) - lava0;
    assert!(lava > 0, "it left lava");
    assert!(lava <= 600 / WISP_TRAIL_EVERY as usize + 1, "at most one cell per trail period: {lava}");
    assert_eq!(s.enemies[0].hp, ENEMY_STATS[usize::from(ENEMY_WISP)].hp, "immune to its own lava");
}

#[test]
fn a_frost_sprite_leaves_ice_and_is_not_immune_to_lava() {
    let mut s = open_arena();
    spawn(&mut s, ENEMY_FROST, 540, 250);
    let ice0 = count(&s, ICE);
    for _ in 0..400 {
        s.step();
        keep_alive(&mut s);
    }
    assert!(count(&s, ICE) > ice0, "it left ice");
    assert_eq!(ENEMY_STATS[usize::from(ENEMY_FROST)].immune, 0);
    // Lava around it hurts.
    let (cx, cy) = (s.enemies[0].x >> 4, (s.enemies[0].y >> 4) - 2);
    let w = s.grid.w;
    for y in cy - 3..=cy + 3 {
        for x in cx - 4..=cx + 4 {
            s.grid.mat[y as usize * w + x as usize] = LAVA;
        }
    }
    let hp = s.enemies[0].hp;
    for _ in 0..20 {
        s.step();
        keep_alive(&mut s);
        if s.enemies.is_empty() {
            break;
        }
    }
    assert!(s.enemies.is_empty() || s.enemies[0].hp < hp, "lava hurt the sprite");
}

#[test]
fn a_dormant_wisp_far_from_players_leaves_nothing() {
    let mut s = open_arena();
    spawn(&mut s, ENEMY_WISP, 120, 250);
    let before = count(&s, LAVA);
    for _ in 0..200 {
        s.step();
        keep_alive(&mut s);
    }
    assert_eq!(count(&s, LAVA), before);
}

#[test]
fn many_wisps_share_one_trail_cell_per_tick() {
    let mut s = open_arena();
    s.enemies = (0..12).map(|i| Enemy::new(i, if i % 2 == 0 { ENEMY_WISP } else { ENEMY_FROST }, (500 + 6 * i32::from(i)) * PX, 250 * PX)).collect();
    let mut prev = count(&s, LAVA) + count(&s, ICE);
    for _ in 0..200 {
        s.step();
        keep_alive(&mut s);
        let now = count(&s, LAVA) + count(&s, ICE);
        assert!(now <= prev + 2 * WISP_TRAIL_PER_TICK as usize, "trail writes per tick are budgeted (ice/lava spread aside)");
        prev = now;
    }
}

#[test]
fn snapshot_roundtrip_and_replay_hashes_match_with_wisps() {
    let mut a = open_arena();
    a.enemies = vec![Enemy::new(0, ENEMY_WISP, 540 * PX, 250 * PX), Enemy::new(1, ENEMY_FROST, 520 * PX, 240 * PX)];
    for _ in 0..150 {
        a.step();
        keep_alive(&mut a);
    }
    let snap = snapshot::write(&a);
    let mut b = snapshot::restore(&snap).expect("decode");
    for _ in 0..150 {
        a.step();
        b.step();
        a.players[0].health = HEALTH_MAX;
        b.players[0].health = HEALTH_MAX;
        assert_eq!(a.state_hash(), b.state_hash());
    }
}

#[test]
fn survival_worlds_place_both_kinds_deterministically() {
    let mut a = Sim::new(7, RoomConfig::survival()).unwrap();
    let mut b = Sim::new(7, RoomConfig::survival()).unwrap();
    assert_eq!(a.state_hash(), b.state_hash());
    assert!(a.enemies.iter().any(|e| e.kind == ENEMY_WISP));
    assert!(a.enemies.iter().any(|e| e.kind == ENEMY_FROST));
    assert!(a.enemies.len() <= MAX_ENEMIES);
}

/// Chebyshev distance from (x, y) to the nearest cell of material `m` within `r`, if any.
fn near(s: &Sim, x: i32, y: i32, m: u8, r: i32) -> bool {
    let (w, h) = (s.grid.w as i32, s.grid.h as i32);
    ((y - r).max(0)..=(y + r).min(h - 1)).any(|yy| ((x - r).max(0)..=(x + r).min(w - 1)).any(|xx| s.grid.mat[(yy * w + xx) as usize] == m))
}

#[test]
fn enemies_are_placed_by_biome() {
    // Seeds whose world holds both lava and ice: every wisp spawns near Lava, every frost sprite near Ice.
    let mut checked = 0;
    for seed in 1..=12u64 {
        let s = Sim::new(seed, RoomConfig::survival()).unwrap();
        let has = |m: u8| s.grid.mat.iter().any(|&c| c == m);
        let (wisps, frosts): (Vec<_>, Vec<_>) = s.enemies.iter().filter(|e| e.kind == ENEMY_WISP || e.kind == ENEMY_FROST).partition(|e| e.kind == ENEMY_WISP);
        assert!(wisps.len() + frosts.len() <= 12, "bounded counts");
        if !(has(LAVA) && has(ICE)) {
            continue;
        }
        checked += 1;
        for e in &wisps {
            assert!(near(&s, e.x / PX, e.y / PX, LAVA, 30), "seed {seed}: wisp at ({}, {}) is not near Lava", e.x / PX, e.y / PX);
        }
        for e in &frosts {
            assert!(near(&s, e.x / PX, e.y / PX, ICE, 30), "seed {seed}: frost sprite at ({}, {}) is not near Ice", e.x / PX, e.y / PX);
        }
        assert!(!wisps.is_empty() || !frosts.is_empty(), "seed {seed}: a world with both biomes places some");
    }
    assert!(checked >= 2, "only {checked} seeds had both biomes");
}

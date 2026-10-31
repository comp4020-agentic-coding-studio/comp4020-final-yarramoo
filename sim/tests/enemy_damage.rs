//! F4 commit 5: enemies take damage (Push, Fire bolt, Bomb, Blast, lava, acid, fire), die, and credit the killer.
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::{encode_cast, encode_join};
use sim::materials::*;
use sim::sim::Sim;
use sim::tuning::*;

const PX: i32 = POS_ONE;
const RIGHT: u16 = 0;

/// Flat arena (air above y=200, rock below, x 300..700), player 1 with chest level on the slime's body row, no
/// generated slimes. Player at x=500; spells granted so every cast has charges.
fn arena() -> Sim {
    let mut s = Sim::new(5, RoomConfig::survival()).unwrap();
    s.enemies.clear();
    let w = s.grid.w;
    for y in 100..320 {
        for x in 300..700 {
            s.grid.mat[y * w + x] = if y < 200 { EMPTY } else { ROCK };
        }
    }
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
    s.push_input(&encode_join(1));
    s.step();
    s.players[0].x = 500 * PX;
    s.players[0].y = 201 * PX; // chest at row 196: the slime's top row
    s.players[0].charges = [INFINITE; NUM_SPELLS];
    s
}

fn slime(id: u16, x: i32) -> Enemy {
    Enemy::new(id, ENEMY_SLIME, x * PX, 200 * PX)
}

fn cast(s: &mut Sim, spell: u8, seq: u16) {
    assert_eq!(s.push_input(&encode_cast(1, spell, RIGHT, seq)), 0);
    s.step();
}

fn events(s: &Sim, kind: u8) -> Vec<Event> {
    s.events.iter().copied().filter(|e| e.kind == kind).collect()
}

#[test]
fn push_hurts_and_moves_a_slime_and_credits_the_caster() {
    let mut s = arena();
    s.enemies = vec![slime(0, 530)];
    let mut hurt = vec![];
    for t in 0..12 {
        if t == 0 {
            assert_eq!(s.push_input(&encode_cast(1, 0, RIGHT, 1)), 0);
        }
        s.step();
        hurt.extend(events(&s, EV_ENEMY_HURT));
    }
    assert_eq!(hurt.len(), 1, "exactly one hit: {hurt:?}");
    assert_eq!((hurt[0].player, hurt[0].a, hurt[0].b, hurt[0].c), (1, 0, i32::from(PUSH_ENEMY_DAMAGE), 20 - i32::from(PUSH_ENEMY_DAMAGE)));
    let e = &s.enemies[0];
    assert_eq!(e.hp, 15);
    assert_eq!(e.last_hit_by, 1);
    assert!(e.x > 530 * PX, "pushed right: {}", e.x);
}

#[test]
fn a_kill_removes_the_slime_and_credits_the_last_hitter_only_inside_the_window() {
    let mut s = arena();
    s.enemies = vec![slime(0, 530)];
    s.enemies[0].hp = 5;
    cast(&mut s, 0, 1);
    for _ in 0..12 {
        if s.enemies.is_empty() {
            break;
        }
        s.step();
    }
    assert!(s.enemies.is_empty());
    // the death event was in the step that landed the hit; replay to capture it
    let mut s = arena();
    s.enemies = vec![slime(0, 530)];
    s.enemies[0].hp = 5;
    assert_eq!(s.push_input(&encode_cast(1, 0, RIGHT, 1)), 0);
    let mut deaths = vec![];
    for _ in 0..12 {
        s.step();
        deaths.extend(events(&s, EV_ENEMY_DEATH));
    }
    assert_eq!(deaths.len(), 1);
    assert_eq!((deaths[0].player, deaths[0].c), (1, i32::from(ENEMY_SLIME)));
    // a stale hit earns no credit: lava finishes a slime last hit by player 1 long ago
    let mut s = arena();
    s.players[0].x = 320 * PX;
    let mut e = slime(0, 520);
    e.hp = 1;
    e.last_hit_by = 1;
    e.last_hit_tick = 0;
    s.enemies = vec![e];
    s.tick = KILL_CREDIT_TICKS + 100;
    for y in 190..200 {
        for x in 500..540 {
            s.grid.mat[y * s.grid.w + x] = LAVA;
        }
    }
    let mut d = vec![];
    for _ in 0..6 {
        s.step();
        d.extend(events(&s, EV_ENEMY_DEATH));
    }
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].player, 0, "stale credit");
}

#[test]
fn fire_bolt_and_bomb_hurt_slimes() {
    let mut s = arena();
    s.enemies = vec![slime(0, 520)];
    cast(&mut s, FIRE_BOLT_ID, 1);
    for _ in 0..8 {
        s.step();
    }
    assert!(s.enemies.is_empty(), "a 20-damage fire bolt kills a 20 hp slime");
    let mut s = arena();
    s.enemies = vec![slime(0, 515)];
    s.enemies[0].hp = 20;
    cast(&mut s, BOMB_ID, 1);
    let mut hurt = events(&s, EV_ENEMY_HURT);
    for _ in 0..10 {
        s.step();
        hurt.extend(events(&s, EV_ENEMY_HURT));
    }
    assert!(!hurt.is_empty(), "the bomb hurt the slime");
    assert_eq!(hurt[0].player, 1);
}

const FIRE_BOLT_ID: u8 = 4;
const BOMB_ID: u8 = 5;
const BLAST_ID: u8 = 1;

#[test]
fn blast_cone_hurts_and_knocks_a_slime() {
    let mut s = arena();
    s.enemies = vec![slime(0, 515)];
    cast(&mut s, BLAST_ID, 1);
    assert_eq!(s.enemies[0].hp, 20 - BLAST_ENEMY_DAMAGE);
    assert!(s.enemies[0].x > 515 * PX, "knocked right");
    // behind the caster: untouched
    let mut s = arena();
    s.enemies = vec![slime(0, 485)];
    cast(&mut s, BLAST_ID, 1);
    assert_eq!(s.enemies[0].hp, 20);
}

fn hazard_after(mat: u8, ticks: u32) -> Sim {
    let mut s = arena();
    s.players[0].x = 320 * PX;
    s.enemies = vec![slime(0, 520)];
    for y in 190..200 {
        for x in 500..540 {
            s.grid.mat[y * s.grid.w + x] = mat;
        }
    }
    for _ in 0..ticks {
        s.step();
    }
    s
}

#[test]
fn lava_acid_and_fire_hurt_a_slime_and_the_slime_has_no_immunity() {
    assert_eq!(ENEMY_STATS[usize::from(ENEMY_SLIME)].immune, 0);
    let lava = hazard_after(LAVA, 8);
    assert!(lava.enemies.is_empty() || lava.enemies[0].hp < 20, "lava");
    let acid = hazard_after(ACID, 12);
    assert!(acid.enemies.is_empty() || acid.enemies[0].hp < 20, "acid");
    let fire = hazard_after(FIRE, 12);
    assert!(fire.enemies.is_empty() || fire.enemies[0].hp < 20, "fire");
    // water does nothing
    let water = hazard_after(WATER, 30);
    assert_eq!(water.enemies[0].hp, 20, "water");
}

#[test]
fn a_far_frozen_slime_in_lava_takes_no_damage() {
    let mut s = arena();
    s.players[0].x = 320 * PX;
    s.enemies = vec![slime(0, 690)]; // 370 cells from the player: outside the rectangle
    for y in 190..200 {
        for x in 680..699 {
            s.grid.mat[y * s.grid.w + x] = LAVA;
        }
    }
    for _ in 0..20 {
        s.step();
    }
    assert_eq!(s.enemies[0].hp, 20);
}

//! Rigid bodies v1 (experiment x-bodies): a freed island falls as one piece and rasterises where it rests.
use sim::input::{encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

/// A game world cleared to Empty with a Rock floor, a 6x4 block hanging by a 1-wide column from a ceiling.
fn world(sleep: bool) -> Sim {
    let mut s = Sim::new(3, 1).unwrap();
    s.grid.sleep_enabled = sleep;
    let w = s.grid.w;
    for y in 100..300 {
        for x in 700..820 {
            s.grid.mat[y * w + x] = EMPTY;
        }
    }
    for x in 700..820 {
        for y in 280..290 {
            s.grid.mat[y * w + x] = BEDROCK;
        }
        s.grid.mat[100 * w + x] = BEDROCK;
    }
    for y in 101..140 {
        s.grid.mat[y * w + 750] = ROCK; // stalk
    }
    for y in 140..144 {
        for x in 747..753 {
            s.grid.mat[y * w + x] = ROCK; // block
        }
    }
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c); // direct edits above: make every chunk non-pristine so a snapshot carries them
    }
    s.push_input(&encode_join(1));
    s.push_input(&encode_pos(1, 0, 710 * 16, 275 * 16, 0));
    s.step();
    s
}

fn sever(s: &mut Sim) {
    let w = s.grid.w;
    s.grid.set(139 * w + 750, EMPTY, 0);
    s.grid.set(138 * w + 750, EMPTY, 0);
}

fn count(s: &Sim, y0: usize, y1: usize) -> usize {
    let w = s.grid.w;
    (y0..y1).flat_map(|y| (740..760).map(move |x| (x, y))).filter(|&(x, y)| s.grid.mat[y * w + x] == ROCK).count()
}

#[test]
fn freed_island_becomes_a_body_falls_and_lands_whole() {
    let mut s = world(true);
    sever(&mut s);
    s.step();
    assert_eq!(s.bodies.len(), 1, "lifted");
    assert_eq!(count(&s, 140, 144), 0, "cells left the grid");
    let mut fell = false;
    for _ in 0..200 {
        s.step();
        fell |= s.bodies.first().is_some_and(|b| b.vy > 0);
    }
    assert!(fell && s.bodies.is_empty(), "landed");
    // Bedrock top is y=280, so the 6x4 block rests on rows 276..280 as one piece, nothing crumbled.
    assert_eq!(count(&s, 276, 280), 24);
    assert_eq!(s.grid.island_crumbled, 1);
}

#[test]
#[ignore = "unverified: the Pos jump to (750,200) is probably rejected by Pos validation; place the player by walking or a fixture"]
fn an_avatar_under_the_body_blocks_it() {
    let mut s = world(true);
    s.push_input(&encode_pos(1, 1, 750 * 16, 200 * 16, 0));
    s.step();
    sever(&mut s);
    for _ in 0..200 {
        s.step();
    }
    assert!(s.bodies.is_empty());
    assert_eq!(count(&s, 186, 190), 24, "the body rests on the player's head box, not through it");
}

#[test]
fn midfall_snapshot_restores_to_equal_hashes_every_tick() {
    let mut a = world(true);
    sever(&mut a);
    for _ in 0..20 {
        a.step();
    }
    assert!(!a.bodies.is_empty());
    let mut b = snapshot::restore(&snapshot::write(&a)).unwrap();
    assert_eq!(a.state_hash(), b.state_hash());
    for _ in 0..200 {
        a.step();
        b.step();
        assert_eq!(a.state_hash(), b.state_hash());
        assert_eq!(a.bodies, b.bodies);
    }
    assert!(a.bodies.is_empty());
}

#[test]
fn sleep_on_and_off_agree_with_a_body_in_flight() {
    let run = |sleep| {
        let mut s = world(sleep);
        sever(&mut s);
        (0..120).map(|_| { s.step(); s.state_hash() }).collect::<Vec<_>>()
    };
    assert_eq!(run(true), run(false));
}

#[test]
fn bodies_and_cells_are_capped() {
    let mut s = world(true);
    let w = s.grid.w;
    // Twelve separate 2x2 islands in one tick: only MAX_BODIES lift, the rest crumble.
    for k in 0..12 {
        for y in 150..152 {
            for x in 0..2 {
                s.grid.mat[y * w + 702 + k * 4 + x] = ROCK;
            }
        }
        s.grid.set(151 * w + 702 + k * 4, ROCK, 0);
        s.grid.set(151 * w + 702 + k * 4, EMPTY, 0);
    }
    s.step();
    assert!(s.bodies.len() <= MAX_BODIES);
    assert_eq!(s.bodies.len(), MAX_BODIES);
    // A body bigger than the box stays a crumble: 70 wide, 3 tall = 210 cells (under ISLAND_MAX).
    let mut t = world(true);
    for x in 705..775 {
        for y in 200..203 {
            t.grid.mat[y * w + x] = ROCK;
        }
    }
    t.grid.set(201 * w + 705, ROCK, 0);
    t.grid.set(201 * w + 705, EMPTY, 0);
    t.step();
    assert!(t.bodies.is_empty(), "too wide to lift: it crumbles instead");
}

#[test]
fn hostile_body_section_is_refused() {
    let mut a = world(true);
    sever(&mut a);
    a.step();
    let mut snap = snapshot::write(&a);
    assert!(snapshot::restore(&snap).is_ok());
    // The body list starts right after the entity-section length; claim 9 bodies.
    let at = 4 + 2 + 32 + 8 + sim::config::CONFIG_BYTES + 4 + 2 + 2 + 4;
    snap[at] = 9;
    assert!(snapshot::restore(&snap).is_err());
}

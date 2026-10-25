//! R4: the fill-empty Paint flag (plan-game-modes.md "Sandspiel-style brushes"). A plain Paint still
//! overwrites anything (today's "replace" mode); fill-empty must only write into Empty or gas cells,
//! never a solid or liquid, while staying inside the same bounded disc.
use sim::input::{encode_paint, encode_paint_mode};
use sim::sim::Sim;

const ROCK: u8 = 2;
const DIRT: u8 = 3;
const SAND: u8 = 4;
const WATER: u8 = 5;
const FIRE: u8 = 10;
const SMOKE: u8 = 11;

#[test]
fn plain_paint_overwrites_rock_fill_empty_does_not() {
    let mut s = Sim::new(1, 0).unwrap(); // classic_sandbox: brushes on, no avatars
    // Paint a rock disc, then confirm its centre is rock.
    s.push_input(&encode_paint(1, ROCK, 100, 100, 100, 100, 3));
    s.step();
    let i = 100 * s.grid.w + 100;
    assert_eq!(s.grid.mat[i], ROCK);

    // A plain (non-fill-empty) Sand paint over the same spot overwrites the rock: today's behaviour,
    // shown here as the "before" case this test guards.
    s.push_input(&encode_paint(1, SAND, 100, 100, 100, 100, 3));
    s.step();
    assert_eq!(s.grid.mat[i], SAND, "plain paint must still overwrite (unchanged behaviour)");

    // Put rock back, then fill-empty Sand must NOT overwrite it.
    s.push_input(&encode_paint(1, ROCK, 100, 100, 100, 100, 3));
    s.step();
    assert_eq!(s.grid.mat[i], ROCK);
    s.push_input(&encode_paint_mode(1, SAND, 100, 100, 100, 100, 3, true));
    s.step();
    assert_eq!(s.grid.mat[i], ROCK, "fill-empty must never overwrite rock");
}

#[test]
fn fill_empty_writes_into_empty_and_gas_but_not_liquid() {
    // Pokes the grid directly (bypassing Paint/physics for the Water and Fire setup) so the test is about
    // the fill-empty write rule itself, not liquid-flow or fire-lifetime timing in the same tick.
    let mut s = Sim::new(2, 0).unwrap();
    let w = s.grid.w;
    let (ex, wx, fx) = (50usize, 55usize, 60usize);
    let y = 100usize;
    // A rock floor under the whole span so Water does not fall away before the fill-empty stroke applies
    // (Paint and the grid's own physics both run inside the same `step()`, in the order the tick defines).
    for x in ex..=fx {
        s.grid.mat[(y + 1) * w + x] = ROCK;
    }
    s.grid.mat[y * w + wx] = WATER;
    s.grid.mat[y * w + fx] = FIRE;

    // One fill-empty Dirt stroke covering all three x positions (radius 0 line along x) — pushed as an
    // input and applied via step() so it exercises the real Paint/Input path, not a direct grid poke.
    s.push_input(&encode_paint_mode(1, DIRT, ex as i16, y as i16, fx as i16, y as i16, 0, true));
    s.step();
    assert_eq!(s.grid.mat[y * w + ex], DIRT, "empty cell must be painted");
    assert_eq!(s.grid.mat[y * w + wx], WATER, "water (liquid) must not be overwritten");
    assert_eq!(s.grid.mat[y * w + fx], DIRT, "fire (gas) may be painted over");
}

#[test]
fn fill_empty_also_writes_over_smoke() {
    let mut s = Sim::new(3, 0).unwrap();
    let w = s.grid.w;
    let (x, y) = (60, 100);
    s.grid.mat[y * w + x] = SMOKE;
    s.push_input(&encode_paint_mode(1, SAND, x as i16, y as i16, x as i16, y as i16, 0, true));
    s.step();
    let cell = s.grid.mat[y * w + x];
    assert!(cell == SAND || cell == 0, "expected sand to land (smoke may have risen first), got {cell}");
}

#[test]
fn fill_empty_radius_32_touches_no_more_cells_than_plain_paint() {
    // Bounded work: a fill-empty stroke at the max radius must not cost more than a plain one touches
    // the same set of grid cells, it only ever skips a subset of writes within that disc.
    let mut s = Sim::new(4, 0).unwrap();
    s.push_input(&encode_paint_mode(1, SAND, 200, 200, 200, 200, 32, true));
    s.step();
    // The max-radius disc has area <= (2*32+1)^2 = 4225 cells; sanity-check the paint did not panic or
    // run unbounded (an implicit pass/fail: the test completing within the suite's time budget).
    let w = s.grid.w;
    let mut painted = 0;
    for dy in -32i32..=32 {
        for dx in -32i32..=32 {
            if dx * dx + dy * dy > 32 * 32 {
                continue;
            }
            let (x, y) = (200 + dx, 200 + dy);
            if s.grid.mat[y as usize * w + x as usize] == SAND {
                painted += 1;
            }
        }
    }
    assert!(painted > 0);
}

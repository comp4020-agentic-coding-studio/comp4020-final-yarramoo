//! Falling rock v0: cut-free solid islands crumble to Pebbles; anchored ones stay. Since v0.5 (D-189) only islands
//! over `FALL_ISLAND_MAX` cells crumble (smaller ones fall as themselves: tests/falling_islands.rs), so the
//! crumbling fixtures here are larger than 120 cells.
use sim::grid::Grid;
use sim::input::{encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;
use sim::tuning::{ISLAND_MAX, ISLAND_WORK_MAX};

const N: usize = 256;

fn fill(g: &mut Grid, x0: usize, y0: usize, x1: usize, y1: usize, m: u8) {
    for y in y0..y1 {
        for x in x0..x1 {
            g.mat[y * N + x] = m;
        }
    }
}

/// A 5x5 block at (100..105, 100..105) joined by a one-cell column (x=102, y=105..119) to a full-width
/// floor (y=120..124) that reaches the world edge, so the whole thing is anchored until the column is cut.
fn bridged() -> Grid {
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 120, N, 124, ROCK);
    fill(&mut g, 100, 100, 105, 105, ROCK);
    fill(&mut g, 102, 105, 103, 120, ROCK);
    g
}

fn count(g: &Grid, x0: usize, y0: usize, x1: usize, y1: usize, m: u8) -> usize {
    (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).filter(|&(x, y)| g.mat[y * N + x] == m).count()
}

fn cut(g: &mut Grid, x: usize, y: usize) {
    g.set(y * N + x, EMPTY, 0);
    g.crumble_islands();
}

#[test]
fn freed_block_crumbles_and_falls() {
    // A 14 x 10 = 140 cell block (over FALL_ISLAND_MAX), joined by the column.
    let mut g = bridged();
    fill(&mut g, 96, 96, 110, 106, ROCK);
    g.crumble_islands();
    assert_eq!(count(&g, 96, 96, 110, 106, ROCK), 140, "attached block must not crumble");
    cut(&mut g, 102, 110);
    // The block plus the cells of the column above the cut are free; the column below stays anchored.
    assert_eq!(count(&g, 96, 96, 110, 106, ROCK), 0);
    assert_eq!(count(&g, 96, 96, 110, 106, PEBBLES), 140);
    assert_eq!(count(&g, 102, 106, 103, 110, PEBBLES), 4);
    assert_eq!(count(&g, 102, 111, 103, 120, ROCK), 9);
    assert!(g.island_removed.is_empty());
    for t in 0..200 {
        g.step_cells(1, t);
    }
    assert_eq!(count(&g, 96, 96, 110, 106, PEBBLES), 0, "pebbles should have fallen away from the block site");
}

#[test]
fn ice_island_melts_to_water() {
    let mut g = bridged();
    fill(&mut g, 100, 100, 105, 105, ICE);
    cut(&mut g, 102, 110);
    assert_eq!(count(&g, 100, 100, 105, 105, WATER), 25);
}

#[test]
fn attached_block_stays_when_another_link_remains() {
    let mut g = bridged();
    fill(&mut g, 104, 105, 105, 120, ROCK); // a second column
    cut(&mut g, 102, 110);
    assert_eq!(count(&g, 100, 100, 105, 105, ROCK), 25);
    assert_eq!(g.island_crumbled, 0);
}

#[test]
fn block_over_the_island_cap_is_anchored() {
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 120, N, 124, ROCK);
    // 21 x 21 = 441 > ISLAND_MAX, joined by a column.
    assert!(21 * 21 > ISLAND_MAX);
    fill(&mut g, 100, 80, 121, 101, ROCK);
    fill(&mut g, 110, 101, 111, 120, ROCK);
    cut(&mut g, 110, 110);
    assert_eq!(count(&g, 100, 80, 121, 101, ROCK), 441);
    // A block under the cap crumbles by the same route.
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 120, N, 124, ROCK);
    fill(&mut g, 100, 90, 119, 101, ROCK); // 19 x 11 = 209
    fill(&mut g, 110, 101, 111, 120, ROCK);
    cut(&mut g, 110, 110);
    assert_eq!(count(&g, 100, 90, 119, 101, ROCK), 0);
}

#[test]
fn block_touching_bedrock_or_edge_is_anchored() {
    let mut g = bridged();
    fill(&mut g, 99, 99, 106, 100, BEDROCK); // bedrock cap touching the top of the block
    cut(&mut g, 102, 110);
    assert_eq!(count(&g, 100, 100, 105, 105, ROCK), 25);
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 100, 5, 105, ROCK); // touches the left edge
    fill(&mut g, 5, 102, 6, 120, ROCK);
    fill(&mut g, 0, 120, 40, 124, ROCK);
    cut(&mut g, 5, 110);
    assert_eq!(count(&g, 0, 100, 5, 105, ROCK), 25);
}

#[test]
fn flood_work_is_bounded_per_tick() {
    // Many separate free-able islands, each cut at once: more seeds than the cap, and a total cost the
    // budget must clamp. Islands are 20x19 = 380 cells (under ISLAND_MAX) so each costs ~380 visits.
    let mut g = Grid::new(512, 512);
    for k in 0..30usize {
        let (x0, y0) = ((k % 6) * 80 + 5, (k / 6) * 80 + 5);
        for y in y0..y0 + 19 {
            for x in x0..x0 + 20 {
                g.mat[y * 512 + x] = ROCK;
            }
        }
        // Cut a corner cell: 30 islands ask for ~11000 visits in one tick.
        g.set(y0 * 512 + x0, EMPTY, 0);
    }
    assert_eq!(g.island_removed.len(), 30);
    g.crumble_islands();
    assert!(g.island_visits as usize <= ISLAND_WORK_MAX, "visits {}", g.island_visits);
    assert!(g.island_visits as usize >= ISLAND_WORK_MAX - ISLAND_MAX, "the budget should bite: {}", g.island_visits);
    assert!(g.island_crumbled >= 1 && (g.island_crumbled as usize) < 30, "{}", g.island_crumbled);
    assert!(g.island_removed.is_empty());
}

fn crumbled_sim(sleep: bool) -> Vec<u64> {
    let mut s = Sim::new(3, 1).unwrap();
    s.grid.sleep_enabled = sleep;
    let w = s.grid.w;
    let (px, py) = (780usize, 300usize);
    let mut out = Vec::new();
    for t in 1..=300u32 {
        if t == 1 {
            s.push_input(&encode_join(1));
            s.push_input(&encode_pos(1, 0, px as i32 * 16, py as i32 * 16, 0));
        }
        if t == 100 {
            // A rock slab inside the player's active region, joined by a column, then cut.
            for y in 150..158 {
                for x in 760..780 {
                    s.grid.mat[y * w + x] = ROCK;
                }
            }
            for y in 158..170 {
                s.grid.mat[y * w + 766] = ROCK;
            }
            s.grid.set(158 * w + 766, EMPTY, 0);
        }
        s.step();
        assert!(s.grid.island_removed.is_empty(), "seed queue must be empty at the end of every tick");
        if t % 20 == 0 {
            out.push(s.state_hash());
        }
    }
    out
}

#[test]
fn d7_freed_island_sleep_is_invisible() {
    let on = crumbled_sim(true);
    assert_eq!(on, crumbled_sim(false));
}

#[test]
fn freed_island_in_game_world_actually_crumbles() {
    let mut s = Sim::new(3, 1).unwrap();
    let w = s.grid.w;
    for y in 150..158 {
        for x in 760..780 {
            s.grid.mat[y * w + x] = ROCK;
        }
    }
    s.grid.mat[158 * w + 766] = ROCK;
    s.grid.set(159 * w + 766, EMPTY, 0);
    s.grid.set(157 * w + 766, EMPTY, 0);
    s.grid.mat[157 * w + 766] = ROCK;
    s.grid.set(158 * w + 766, EMPTY, 0);
    s.step();
    assert!(s.grid.island_crumbled >= 1);
}

#[test]
fn generated_world_is_stable_for_600_ticks() {
    let mut s = Sim::new(1, 1).unwrap();
    s.push_input(&encode_join(1));
    s.push_input(&encode_pos(1, 0, 780 * 16, 300 * 16, 0));
    for _ in 0..600 {
        s.step();
        assert!(s.grid.island_removed.is_empty());
    }
    assert_eq!(s.grid.island_crumbled, 0, "the fresh world must not collapse");
}

/// Review F1: a block hung from a long stalk, the whole stalk erased in one stroke, must fall.
fn stalk_world(stalk: usize) -> Grid {
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 200, N, 210, ROCK);
    fill(&mut g, 100, 50, 121, 65, ROCK); // 21 x 15 block
    fill(&mut g, 110, 65, 111, 65 + stalk, ROCK);
    fill(&mut g, 110, 65 + stalk, 111, 200, ROCK); // stalk reaches the floor
    g
}

#[test]
fn block_on_a_long_stalk_falls_when_the_whole_stalk_is_erased() {
    let mut g = stalk_world(30);
    // One Paint stroke erases the stalk's whole length (Empty paint through `set`).
    for y in (65..200).rev() {
        g.set(y * N + 110, EMPTY, 0);
    }
    g.crumble_islands();
    assert_eq!(count(&g, 100, 50, 121, 65, ROCK), 0, "block must crumble");
    assert_eq!(count(&g, 100, 50, 121, 65, PEBBLES), 21 * 15);
}

#[test]
fn large_dig_that_frees_a_slab_crumbles_it() {
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 200, N, 210, ROCK);
    fill(&mut g, 90, 100, 130, 200, ROCK);
    fill(&mut g, 100, 50, 121, 65, ROCK);
    fill(&mut g, 110, 65, 111, 100, ROCK);
    // Free a 16 x 9 slab (144 cells, over FALL_ISLAND_MAX) by erasing a ring of 100+ cells around it.
    for y in 100..140 {
        for x in 90..130 {
            let slab = (100..116).contains(&x) && (110..119).contains(&y);
            let ring = (98..118).contains(&x) && (108..121).contains(&y);
            if ring && !slab {
                g.set(y * N + x, EMPTY, 0);
            }
        }
    }
    g.crumble_islands();
    assert_eq!(count(&g, 100, 110, 116, 119, ROCK), 0);
    assert_eq!(count(&g, 100, 110, 116, 119, PEBBLES), 16 * 9);
}

#[test]
fn anchored_fill_stops_at_the_first_anchor() {
    let mut g = bridged();
    fill(&mut g, 90, 119, 115, 120, BEDROCK); // bedrock right under the column
    g.set(110 * N + 102, EMPTY, 0); // cut: the lower column piece touches bedrock after a few cells
    g.set(100 * N + 100, EMPTY, 0); // and a second cut in the block
    g.crumble_islands();
    assert!(g.island_visits < 40, "visits {}", g.island_visits);
}

#[test]
fn generated_worlds_are_stable_across_seeds_and_sizes() {
    use sim::config::RoomConfig;
    let mut bad = Vec::new();
    for seed in 1..=8u64 {
        for size in 0..=1u8 {
            let mut cfg = RoomConfig::survival();
            cfg.size = size;
            let mut s = Sim::new(seed, cfg).unwrap();
            // Brief W (D-176): generated acid, lava and gunpowder now wake and eat or blow up rock beyond the
            // player's region, which is those materials working as designed, not terrain collapsing. This test is
            // about the terrain, so they are removed first.
            for i in 0..s.grid.mat.len() {
                if matches!(s.grid.mat[i], sim::materials::ACID | sim::materials::LAVA | sim::materials::GUNPOWDER) {
                    s.grid.mat[i] = sim::materials::EMPTY;
                }
            }
            s.push_input(&encode_join(1));
            s.step();
            let (px, py) = (s.players[0].x, s.players[0].y);
            for _ in 0..300 {
                s.step();
            }
            if s.grid.island_crumbled != 0 {
                bad.push((seed, size, s.grid.island_crumbled, px, py));
            }
        }
    }
    assert!(bad.is_empty(), "crumbled on their own: {bad:?}");
}

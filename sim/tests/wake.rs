//! Brief W (D-176): a frozen chunk wakes when a running chunk changes a cell next to it, with no cap.
//! These tests use only the public grid, so they compile before and after the change.
use sim::grid::Grid;
use sim::input::{encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;

const W: usize = 1024;
const H: usize = 128;

/// A bedrock floor, a left wall, and the active region around x = 200 (chunks up to x < 512 are active).
fn world() -> Grid {
    let mut g = Grid::new(W, H);
    g.sleep_enabled = true;
    for x in 0..W {
        g.set((H - 1) * W + x, BEDROCK, 0);
    }
    for y in 0..H {
        g.set(y * W + 20, ROCK, 0);
    }
    g.set_active_around(&[(200, 64)]);
    g
}

fn run(g: &mut Grid, from: u32, to: u32) {
    for t in from..to {
        g.step_cells(5, t);
    }
}

/// The old assertion's intent: a frozen chunk that nothing reaches is not stepped and does not change.
#[test]
fn a_frozen_chunk_nothing_reaches_stays_frozen() {
    let mut g = world();
    // Water hanging in mid-air far inside the frozen region. Built while everything is active (a `set` on a
    // frozen chunk is itself a change and would wake it), then the region is narrowed back to the player.
    g.set_all_active();
    for y in 60..70 {
        for x in 800..820 {
            g.set(y * W + x, WATER, 0);
        }
    }
    g.set_active_around(&[(200, 64)]);
    g.woken.fill(false);
    // Settle the active region.
    run(&mut g, 0, 50);
    let before = g.mat.clone();
    run(&mut g, 50, 300);
    assert_eq!(g.mat, before, "a frozen, unreached region changed");
    assert_eq!(g.ran_chunks, 0, "nothing should be running");
}

/// Fire spreading out of the region keeps burning in the frozen chunks it reaches.
#[test]
fn fire_spreading_out_of_the_region_keeps_burning() {
    let mut g = world();
    // Oil ignites readily (1 in 2 per neighbour), so the front runs the whole strip.
    for x in 300..800 {
        g.set((H - 2) * W + x, OIL, 0);
    }
    g.set((H - 3) * W + 320, FIRE, 0);
    run(&mut g, 0, 6000);
    let burnt_far = (700..800).filter(|&x| g.mat[(H - 2) * W + x] != OIL).count();
    assert!(burnt_far >= 50, "fire did not carry on across the edge: {burnt_far} of 100 burnt");
}

/// A seed in a frozen chunk, reached by water from the active region, germinates and grows. The scene is built and
/// then the region re-frozen (a `set` on a frozen chunk wakes it), and the seed's chunk must stay frozen until the
/// water gets there, so only the water can have woken it.
#[test]
fn a_seed_reached_by_water_across_the_edge_grows() {
    let mut g = world();
    g.set_all_active();
    for x in 21..W {
        g.set((H - 2) * W + x, DIRT, 0);
    }
    for y in 80..H - 2 {
        for x in 21..80 {
            g.set(y * W + x, WATER, 0);
        }
    }
    // On a 3-wide dirt post just above the ~3-deep film: water beside it at x = 528 is inside the seed's 5 x 5 wet
    // check, the seed (a powder) cannot slide off diagonally, and the stem is not drowned (a stem grows only into
    // empty cells, and water arrives about 1500 ticks sooner since D-191).
    for y in H - 5..H - 2 {
        for x in 529..532 {
            g.set(y * W + x, DIRT, 0);
        }
    }
    g.set((H - 6) * W + 530, SEED, 0);
    g.set_active_around(&[(200, 64)]);
    g.woken.fill(false);
    let c = g.chunk_of(530, H - 6);
    assert!(!g.active[c], "the seed must be in a frozen chunk");
    let mut t = 0;
    while !(0..H).any(|y| (512..W).any(|x| g.mat[y * W + x] == WATER)) {
        assert!(!g.woken[c] && g.mat[(H - 6) * W + 530] == SEED, "the seed's chunk ran before water reached it");
        g.step_cells(5, t);
        t += 1;
        assert!(t < 12000, "water never crossed into the frozen chunk");
    }
    run(&mut g, t, 12000);
    // Stems lean, so count plant cells anywhere above the post, not just in its column.
    let plant = (0..H - 5).flat_map(|y| (520..541).map(move |x| y * W + x)).filter(|&i| matches!(g.mat[i], STEM | FLOWER)).count();
    assert!(plant >= 3, "the seed never grew across the edge ({plant} plant cells)");
}

fn flow_script(sleep: bool) -> Vec<(u32, u64)> {
    // A game world, the player at the first entrance shaft, a carved cavity spanning the region's edge.
    let (x, y) = (500usize, 700usize);
    let mut s = Sim::new(9, 1).unwrap();
    s.grid.sleep_enabled = sleep;
    let w = s.grid.w;
    let mut out = Vec::new();
    for t in 1..=900u32 {
        if t == 1 {
            s.push_input(&encode_join(1));
            s.push_input(&encode_pos(1, 0, (x as i32) * 16, (y as i32) * 16, 0));
        }
        if t == 100 {
            // Region edge is x = 788 (chunk edge 832): carve air across it and drop water on the left.
            for cy in 680..712 {
                for cx in 760..900 {
                    s.grid.set(cy * w + cx, EMPTY, 0);
                }
            }
            for cy in 690..700 {
                for cx in 770..790 {
                    s.grid.set(cy * w + cx, WATER, 0);
                }
            }
        }
        s.step();
        if t % 30 == 0 {
            out.push((t, s.state_hash()));
        }
    }
    out
}

/// Sleep on and off agree in a game world while a flow crosses the region's edge (woken chunks run the
/// same either way).
#[test]
fn sleep_on_and_off_agree_while_a_flow_crosses_the_region_edge() {
    assert_eq!(flow_script(true), flow_script(false));
}

/// Woken chunks return to frozen once the flow settles. Sand is used because it truly comes to rest. A water
/// film does not: its surface cells keep swapping sides at random, in active chunks too, so a woken chunk holding
/// a free water surface stays woken (measured in docs/research/wake-load-results.md, a finding for review).
#[test]
fn woken_chunks_return_to_frozen_once_settled() {
    let mut g = world();
    // A tall sand pile straddling the region's edge (x = 512) slumps into the frozen chunks and comes to rest.
    for y in 60..H - 1 {
        for x in 490..510 {
            g.set(y * W + x, SAND, 0);
        }
    }
    let mut peak = 0;
    for t in 0..20000 {
        g.step_cells(5, t);
        peak = peak.max(g.woken_frozen());
    }
    assert!(peak > 0, "the flow never woke a frozen chunk");
    assert_eq!(g.woken_frozen(), 0, "woken chunks never went back to frozen");
    assert_eq!(g.ran_chunks, 0);
}

/// D5-style: a snapshot taken while chunks are woken, restored, then run on, hashes like the uninterrupted run.
#[test]
fn snapshot_while_chunks_are_woken_restores_and_continues_identically() {
    let (x, y) = (500usize, 700usize);
    let mk = || {
        let mut s = Sim::new(9, 1).unwrap();
        s.push_input(&encode_join(1));
        s.push_input(&encode_pos(1, 0, (x as i32) * 16, (y as i32) * 16, 0));
        s
    };
    let carve = |s: &mut Sim| {
        let w = s.grid.w;
        for cy in 680..712 {
            for cx in 760..900 {
                s.grid.set(cy * w + cx, EMPTY, 0);
            }
        }
        for cy in 690..700 {
            for cx in 770..790 {
                s.grid.set(cy * w + cx, WATER, 0);
            }
        }
    };
    let mut full = mk();
    let mut s = mk();
    for t in 1..=400u32 {
        if t == 100 {
            carve(&mut full);
            carve(&mut s);
        }
        full.step();
        if t <= 160 {
            s.step();
        }
    }
    assert!(s.grid.woken_frozen() > 0, "the cut must fall while chunks are woken");
    let snap = sim::snapshot::write(&s);
    assert_eq!(snap.len(), sim::snapshot::size(&s));
    let mut r = sim::snapshot::restore(&snap).unwrap();
    assert_eq!(r.grid.woken, s.grid.woken);
    assert_eq!(r.state_hash(), s.state_hash());
    for _ in 161..=400u32 {
        r.step();
    }
    assert_eq!(r.state_hash(), full.state_hash());
    assert_eq!(r.grid.woken, full.grid.woken);
}

/// A woken bit is semantic state: it is in the hash.
#[test]
fn woken_bits_are_in_the_state_hash() {
    let mut a = Sim::new(3, 1).unwrap();
    let b = Sim::new(3, 1).unwrap();
    a.grid.woken[5] = true;
    let mut b = b;
    assert_ne!(a.state_hash(), b.state_hash());
}

/// Review W F1: `touch` reads the scratch `active` vector to decide `woken`, and inputs are applied before
/// `refresh_active`. A restored sim starts with `active` all true, a running one holds last tick's region, so a
/// Paint outside the region on the first tick after a restore woke the chunk on one and not the other: the hashes
/// diverged for any client joining mid-game. Size-1 world (1024 x 768), player at (200, 100), so x = 900 is frozen.
#[test]
fn a_write_outside_the_region_on_the_first_tick_after_restore_matches_the_running_sim() {
    use sim::config::{RoomConfig, TERRAIN_EMPTY_BOX};
    use sim::input::encode_paint;
    // Empty box: the paint at y = 100 is water in open air, so it keeps falling and its chunk stays busy.
    let cfg = RoomConfig { terrain: TERRAIN_EMPTY_BOX, size: 1, avatars: 1, damage: 0, spells: 1, brushes: 1, death: 0, respawn_secs: 1, pickup_respawn: 1, round: 0, max_players: 8, enemies: 0 };
    let mut a = Sim::new(4, cfg).unwrap();
    a.push_input(&encode_join(1));
    a.push_input(&encode_pos(1, 0, 200 * 16, 100 * 16, 0));
    for _ in 0..60 {
        a.step();
    }
    assert!(!a.grid.active[a.grid.chunk_of(900, 100)], "x = 900 must be outside the player's region");
    let mut b = sim::snapshot::restore(&sim::snapshot::write(&a)).unwrap();
    assert_eq!(a.state_hash(), b.state_hash());
    let paint = encode_paint(1, WATER, 900, 100, 900, 100, 4);
    a.push_input(&paint);
    b.push_input(&paint);
    a.step();
    b.step();
    assert_eq!(a.grid.woken, b.grid.woken, "the first tick after restore woke different chunks");
    assert_eq!(a.state_hash(), b.state_hash(), "the restored sim diverged on its first tick");
}

//! D7: sleeping is invisible. The same script with sleeping on and off must hash identically at every
//! checkpoint, in both world kinds. Scripts leave regions quiet, then disturb them.
use sim::input::encode_paint;
use sim::sim::Sim;

type Script = Vec<(u32, Vec<u8>)>;

fn paint(mat: u8, x0: i16, y0: i16, x1: i16, y1: i16, r: u8) -> Vec<u8> {
    encode_paint(1, mat, x0, y0, x1, y1, r)
}

/// Run `ticks`, hashing every `every` ticks, with sleeping on or off.
fn run(kind: u8, seed: u64, sleep: bool, ticks: u32, every: u32, script: &Script) -> Vec<(u32, u64)> {
    let mut s = Sim::new(seed, kind).unwrap();
    s.grid.sleep_enabled = sleep;
    let mut out = vec![(0, s.state_hash())];
    for t in 1..=ticks {
        for (_, b) in script.iter().filter(|(tt, _)| *tt == t) {
            assert_eq!(s.push_input(b), 0);
        }
        s.step();
        if t % every == 0 {
            out.push((t, s.state_hash()));
        }
    }
    out
}

fn same(kind: u8, seed: u64, ticks: u32, every: u32, script: &Script) {
    let a = run(kind, seed, true, ticks, every, script);
    let b = run(kind, seed, false, ticks, every, script);
    assert_eq!(a, b, "world_kind {kind}: sleeping changed the result");
    assert!(a.windows(2).any(|w| w[0].1 != w[1].1), "script must change the world");
}

/// Sandbox script: settle a pile, wait, then disturb in several ways across chunk borders.
fn sandbox_script() -> Script {
    vec![
        // Sand and water either side of the x=128 chunk edge, then quiet.
        (1, paint(4, 100, 100, 156, 100, 6)),
        (1, paint(5, 300, 60, 300, 140, 5)),
        (2, paint(3, 20, 480, 490, 480, 3)),
        // After they settle: paint into a sleeping region.
        (400, paint(4, 110, 40, 110, 60, 8)),
        // A gunpowder line crossing chunk edges with fire at one end: explosion at an edge (x = 191..193).
        (500, paint(13, 140, 300, 200, 300, 2)),
        (505, paint(10, 200, 300, 202, 300, 1)),
        // Water poured onto a ledge so it flows across x = 256 into a sleeping chunk.
        (700, paint(2, 230, 400, 330, 400, 2)),
        (702, paint(5, 245, 380, 250, 380, 3)),
        // Lava onto water, and a seed on dirt.
        (900, paint(14, 60, 200, 60, 205, 4)),
        (905, paint(5, 66, 200, 66, 205, 4)),
        (1100, paint(7, 30, 470, 34, 470, 1)),
        // Erase into a quiet pile.
        (1300, paint(0, 90, 90, 160, 120, 10)),
    ]
}

#[test]
fn d7_sandbox_sleep_is_invisible() {
    same(0, 11, 1700, 20, &sandbox_script());
}

#[test]
fn d7_sandbox_hash_every_tick() {
    // Reading the hash every tick must not perturb sleeping either.
    let s = sandbox_script();
    let a = run(0, 3, true, 600, 1, &s);
    let b = run(0, 3, false, 600, 1, &s);
    assert_eq!(a, b);
}

/// Disturbances inside the game world are made through Paint, which is sandbox-only (the game world
/// ignores it), so the game-world script is the world itself: generated water, lava, sand and
/// gunpowder settle (most chunks go quiet) while trees, caves and pools keep some chunks busy.
#[test]
fn d7_game_world_sleep_is_invisible() {
    // With no active player the world is frozen (plan 6.5), so a player's Join + Pos activates the
    // region around the first entrance shaft, where generated water, lava and sand settle.
    use sim::input::{encode_join, encode_pos};
    let mut script: Script = vec![(1, encode_join(1)), (1, encode_pos(1, 0, 780 * 16, 300 * 16, 0))];
    // Keep standing there; the Pos input each 100 ticks also exercises repeated inputs.
    for t in (100..600).step_by(100) {
        script.push((t, encode_pos(1, 0, 780 * 16, 300 * 16, 0)));
    }
    same(1, 5, 600, 30, &script);
}

/// Game worlds ignore Paint today, so build a disturbed game world directly on the grid: two runs of
/// the same Sim, one with sleeping, then edit cells (as an explosion or a future spell would, through
/// `Grid::set`) at chunk borders after a quiet period.
#[test]
fn d7_game_world_disturbed_after_quiet() {
    for &(x, y) in &[(1023usize, 700usize), (1024, 700), (500, 767), (64 * 7 + 1, 1000)] {
        let go = |sleep: bool| {
            let mut s = Sim::new(9, 1).unwrap();
            s.grid.sleep_enabled = sleep;
            let w = s.grid.w;
            let mut out = Vec::new();
            for t in 1..=900u32 {
                if t == 1 {
                    // A player standing at the disturbance keeps its region active.
                    s.push_input(&sim::input::encode_join(1));
                    s.push_input(&sim::input::encode_pos(1, 0, (x as i32) * 16, (y as i32) * 16, 0));
                }
                if t == 300 {
                    // Water and fire dropped into settled ground and cave air, straddling a chunk edge.
                    for k in 0..6 {
                        s.grid.set((y - 3) * w + x - 3 + k, 5, 0);
                        s.grid.set((y - 4) * w + x - 3 + k, 10, 0);
                        s.grid.set((y - 5) * w + x - 3 + k, 13, 0);
                    }
                }
                s.step();
                if t % 50 == 0 {
                    out.push((t, s.state_hash()));
                }
            }
            out
        };
        assert_eq!(go(true), go(false), "disturbance at {x},{y}");
    }
}

#[test]
fn sleeping_actually_skips_work() {
    let mut s = Sim::new(5, 1).unwrap();
    let all = s.grid.chunk_count() as u32;
    s.push_input(&sim::input::encode_join(1));
    s.push_input(&sim::input::encode_pos(1, 0, 780 * 16, 300 * 16, 0));
    for _ in 0..1500 {
        s.step();
    }
    s.step();
    assert!(s.grid.ran_chunks < all / 8, "{} of {} chunks still ran", s.grid.ran_chunks, all);
}

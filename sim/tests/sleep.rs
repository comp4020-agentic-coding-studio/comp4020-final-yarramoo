//! D7: sleeping is invisible. The same script with sleeping on and off must hash identically at every
//! checkpoint, in both world kinds. Scripts leave regions quiet, then disturb them.
use sim::input::encode_paint;
use sim::grid::CHUNK_AREA;
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

/// F2: every new material, with sleeping chunks next to them. Oil on water, acid on rock and next to a
/// sleeping sand pile, a gas pocket lit by fire, ice by lava and by water, sand by lava, and a coal fuse,
/// all straddling chunk edges (x = 128, 256) and disturbed after a quiet spell.
fn materials_script() -> Script {
    vec![
        // Rock shelf and basin across the x=256 edge, water, then oil poured on it later.
        (1, paint(2, 230, 300, 290, 300, 2)),
        (2, paint(5, 240, 290, 280, 294, 4)),
        (300, paint(15, 255, 250, 262, 250, 5)),
        // Acid dropped on a rock shelf next to a settled sand pile (a sleeping chunk).
        (1, paint(4, 100, 200, 120, 200, 5)),
        (1, paint(2, 90, 240, 150, 240, 3)),
        (400, paint(16, 125, 200, 131, 200, 4)),
        // A gas pocket under a rock roof, lit later by fire.
        (1, paint(2, 300, 360, 380, 360, 2)),
        (1, paint(2, 300, 360, 300, 400, 2)),
        (1, paint(2, 380, 360, 380, 400, 2)),
        (2, paint(17, 310, 365, 370, 380, 6)),
        (600, paint(10, 340, 395, 342, 395, 1)),
        // Ice beside water and beside lava, across the x=128 edge.
        (1, paint(2, 100, 440, 160, 440, 2)),
        (2, paint(18, 120, 435, 136, 435, 3)),
        (3, paint(5, 138, 430, 150, 432, 3)),
        (800, paint(14, 126, 420, 126, 424, 3)),
        // Sand then lava: glass.
        (1, paint(2, 400, 470, 470, 470, 2)),
        (2, paint(4, 420, 460, 440, 465, 3)),
        (900, paint(14, 430, 440, 434, 442, 3)),
        // A coal fuse lit by fire after a quiet spell.
        (1, paint(20, 20, 300, 120, 300, 2)),
        (1100, paint(10, 20, 296, 22, 296, 1)),
        // Digging-by-erase into settled ice and glass.
        (1500, paint(0, 100, 430, 160, 445, 6)),
    ]
}

#[test]
fn d7_new_materials_sleep_is_invisible() {
    same(0, 13, 2200, 20, &materials_script());
}

/// A quiet basin whose only activity is ice freezing the water beside it by chance: if the ice did not keep
/// its chunk awake, the sleeping run would stop freezing and diverge from the awake one.
#[test]
fn d7_ice_by_water_keeps_its_chunk_awake() {
    // A one-cell-wide channel: walls at x = 69 and 71, ice on the floor, water above it. The ice has
    // exactly one water neighbour, so a freeze is a lone 1-in-20 roll per tick with nothing else moving.
    let script: Script = vec![
        (1, paint(2, 69, 250, 69, 300, 0)),
        (1, paint(2, 71, 250, 71, 300, 0)),
        (1, paint(2, 70, 300, 70, 300, 0)),
        (2, paint(18, 70, 299, 70, 299, 0)),
        (500, paint(5, 70, 290, 70, 298, 0)),
    ];
    same(0, 21, 3000, 100, &script);
}

#[test]
fn d7_new_materials_hash_every_tick() {
    let s = materials_script();
    let a = run(0, 4, true, 700, 1, &s);
    let b = run(0, 4, false, 700, 1, &s);
    assert_eq!(a, b);
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

/// Bounded work, counted rather than timed. A region packed with Acid over Rock, one packed with Gas and Fire
/// (which flashes the pocket in the first ticks) and one of Water as the baseline each run 60 ticks. Per tick
/// we take `ran_chunks` (chunks stepped; each is a fixed CHUNK_AREA cells of work) and the number of cells whose
/// material or aux changed, and keep the MAX over ticks, the first and flash ticks included.
/// - Chunks: the bound is every chunk of the grid, once (`w*h / CHUNK_AREA`). The packed region keeps the whole
///   sandbox awake, so the measured max reaches the bound, and `HALVED` shows a bound half as large fails.
/// - Cells changed: reported in /tmp/f2-work.txt, not bounded tightly (a flash fire changes most of a pocket).

struct Work {
    max_chunks: u32,
    max_changed: usize,
    max_changed_after_first: usize,
    area: usize,
    cells: usize,
}

fn max_work(fill: u8, lit: u8) -> Work {
    let mut s = Sim::new(3, 0).unwrap();
    s.grid.set_all_active();
    let mut area = 0;
    for y in 100..400usize {
        for x in 20..490usize {
            let i = y * s.grid.w + x;
            let m = if y > 380 { 2 } else if (x + y) % 7 == 0 { lit } else { fill };
            s.grid.set(i, m, 0);
            area += 1;
        }
    }
    let mut w = Work { max_chunks: 0, max_changed: 0, max_changed_after_first: 0, area, cells: s.grid.w * s.grid.h };
    for t in 0..60 {
        let (m0, a0) = (s.grid.mat.clone(), s.grid.aux.clone());
        s.step();
        let changed = (0..m0.len()).filter(|&i| m0[i] != s.grid.mat[i] || a0[i] != s.grid.aux[i]).count();
        w.max_changed = w.max_changed.max(changed);
        if t > 0 {
            w.max_changed_after_first = w.max_changed_after_first.max(changed);
        }
        w.max_chunks = w.max_chunks.max(s.grid.ran_chunks);
    }
    w
}

#[test]
fn new_materials_keep_a_tick_within_bounds() {
    let mut report = String::new();
    for (name, fill, lit) in [("water", 5u8, 5u8), ("acid", 16, 16), ("gas+fire", 17, 10)] {
        let w = max_work(fill, lit);
        let chunk_bound = (w.cells / CHUNK_AREA) as u32;
        report += &format!(
            "{name}: max chunks {} (bound {chunk_bound}), max changed {} (after first {}), area {}\n",
            w.max_chunks, w.max_changed, w.max_changed_after_first, w.area
        );
        assert!(w.max_chunks <= chunk_bound, "{name}: {} chunks stepped in one tick, bound {chunk_bound}", w.max_chunks);
        // Tightness: the bound is not slack. Half of it would fail.
        assert!(w.max_chunks > chunk_bound / 2, "{name}: bound {chunk_bound} is more than twice the measured max {}", w.max_chunks);
        // Changes are only reported: a flash fire legitimately changes most of a packed pocket in a tick.
        assert!(w.max_changed <= w.cells, "{name}: more cells changed than exist");
    }
    let _ = std::fs::write("/tmp/f2-work.txt", report);
}

/// F3: a Black Hole boring through a region that has been asleep. Game world, so players exist; a Black Hole
/// is cast into the rock beside the spawn after a quiet spell, with sleeping on and off.
#[test]
fn d7_black_hole_boring_through_a_sleeping_region_is_invisible() {
    use sim::input::{encode_cast, encode_join, encode_pos};
    use sim::materials::ROCK;
    use sim::tuning::POS_ONE;
    let run = |sleep: bool| -> Vec<u64> {
        let mut s = Sim::new(5, 1).unwrap();
        s.grid.sleep_enabled = sleep;
        let w = s.grid.w;
        for y in 100..200 {
            for x in 900..1300 {
                s.grid.mat[y * w + x] = if y >= 192 || x >= 1030 { ROCK } else { 0 };
            }
        }
        for c in 0..s.grid.chunk_count() {
            s.grid.mark_chunk(c);
        }
        assert_eq!(s.push_input(&encode_join(1)), 0);
        s.step();
        s.players[0].charges[11] = 5;
        let life = s.players[0].life;
        assert_eq!(s.push_input(&encode_pos(1, life, 1000 * POS_ONE, 190 * POS_ONE, 0)), 0);
        let mut out = Vec::new();
        for t in 1..=400u32 {
            if t == 150 {
                assert_eq!(s.push_input(&encode_cast(1, 11, 0, 1)), 0);
            }
            s.step();
            if t % 10 == 0 {
                out.push(s.state_hash());
            }
        }
        out
    };
    let (a, b) = (run(true), run(false));
    assert_eq!(a, b, "sleeping changed a Black Hole's result");
    assert!(a.windows(2).any(|w| w[0] != w[1]));
}

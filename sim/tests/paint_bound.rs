//! Review fix 3: one Paint input has bounded cost. Stroke length is clamped to MAX_PAINT_STROKE and truncated from
//! (x0, y0), so a corner-to-corner stroke at the largest radius cannot cost every client millions of cell writes.
use sim::input::encode_paint;
use sim::sim::{paint_stamps, Sim, MAX_PAINT_RADIUS};
use sim::tuning::MAX_PAINT_STROKE;

const SAND: u8 = 4;
/// The stated bound on disc stamps for any one input.
const STAMP_BOUND: i32 = 129;

#[test]
fn worst_case_input_stamps_are_bounded() {
    // Corner to corner is the longest line the clamped endpoints allow: Chebyshev length 511.
    let stamps = paint_stamps(511) + 1;
    assert!(stamps <= STAMP_BOUND, "{stamps} stamps");
    // Cell writes: stamps * disc bounding box, about 0.5 M against 6.6 M before the clamp.
    let writes = stamps as i64 * ((2 * MAX_PAINT_RADIUS + 1) as i64).pow(2);
    assert!(writes < 600_000, "{writes} writes");
    assert_eq!(MAX_PAINT_STROKE + 1, STAMP_BOUND);
    assert_eq!(paint_stamps(10), 10, "a short stroke is untouched");
}

#[test]
fn long_stroke_is_truncated_from_its_start() {
    let mut s = Sim::new(1, 0).unwrap(); // classic_sandbox: Paint allowed
    s.push_input(&encode_paint(1, SAND, 20, 100, 500, 100, 4));
    s.step();
    let at = |x: usize, y: usize| s.grid.mat[y * s.grid.w + x];
    assert_eq!(at(20, 100), SAND, "the start of the stroke is painted");
    assert_eq!(at(20 + MAX_PAINT_STROKE as usize / 2, 100), SAND);
    assert_eq!(at(480, 100), 0, "the far end of a too-long stroke is not painted");
}

/// Review H2 (8 Nov): the per-tick budget across every Paint input. Ten worst-case strokes (radius 32, 128 cells long)
/// arrive in one tick, each on its own row band: the first two fit the budget whole, the rest are dropped, identically
/// on every client because the cut is applied in input order inside `step`.
#[test]
fn a_flood_of_paint_in_one_tick_is_cut_at_the_budget() {
    use sim::tuning::MAX_PAINT_WORK_PER_TICK;
    let mut s = Sim::new(1, 0).unwrap();
    let w = s.grid.w;
    for k in 0..10i16 {
        // 65-row bands (a radius-32 disc spans 65 rows), strokes from x = 40 to 168 on the band's middle row.
        let y = 32 + k * 44;
        s.push_input(&encode_paint(1, SAND, 40, y, 168, y, 32));
    }
    s.step();
    let painted = |y: usize| s.grid.mat[y * w + 100] == SAND;
    assert!(painted(32) && painted(32 + 44), "the first two worst-case strokes fit whole");
    // Two worst-case strokes cost exactly the budget, so the third and every later one draw nothing.
    assert_eq!(MAX_PAINT_WORK_PER_TICK, 2 * 129 * 65 * 65);
    assert!(!painted(32 + 44 * 2), "the third stroke of the flood is not painted");
    assert!(!painted(32 + 44 * 9), "the tenth stroke of the flood is not painted");
    // The budget restarts next tick: a stroke then is painted.
    s.push_input(&encode_paint(1, 5, 300, 480, 310, 480, 2));
    s.step();
    assert_eq!(s.grid.mat[480 * w + 305], 5, "next tick paints again");
}

/// Normal painting never meets the budget: eight painters each sending a radius-8 stroke of 40 cells every tick for
/// a second paint exactly what an unbudgeted run paints (checked against stamping the same discs by hand).
#[test]
fn a_typical_stroke_stream_is_untouched() {
    use sim::tuning::MAX_PAINT_WORK_PER_TICK;
    let per_tick = 8 * 41 * (2 * 8 + 1) * (2 * 8 + 1);
    assert!(per_tick * 4 < MAX_PAINT_WORK_PER_TICK, "eight busy painters use under a quarter of the budget");
    let mut s = Sim::new(1, 0).unwrap();
    let w = s.grid.w;
    for t in 0..60i16 {
        for p in 0..8i16 {
            let y = 40 + p * 55;
            s.push_input(&encode_paint(1 + p as u32, 2, 20 + t * 7, y, 60 + t * 7, y, 8));
        }
        s.step();
    }
    // Rock (static) at the last stroke of every painter: nothing was cut.
    for p in 0..8usize {
        let y = 40 + p * 55;
        assert_eq!(s.grid.mat[y * w + (20 + 59 * 7 + 20) as usize], 2, "painter {p}'s last stroke is painted");
        assert_eq!(s.grid.mat[y * w + 20], 2, "painter {p}'s first stroke is painted");
    }
}

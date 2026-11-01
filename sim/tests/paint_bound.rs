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

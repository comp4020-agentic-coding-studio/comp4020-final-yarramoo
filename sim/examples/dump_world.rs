//! Dev tool: `cargo run --release --example dump_world -- SEED out.raw` writes the generated game
//! world as RGB bytes (2048 x 1536) and prints the generation time.
#![allow(clippy::disallowed_methods)] // a dev timing tool, not part of the sim
use std::io::Write;
fn main() {
    let seed: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(1);
    let out = std::env::args().nth(2).expect("usage: dump_world SEED out.raw");
    let t = std::time::Instant::now();
    let s = sim::sim::Sim::new(seed, 1).unwrap();
    eprintln!("generated in {:?}", t.elapsed());
    let pal: [[u8; 3]; 16] = [
        [11, 14, 20], [43, 45, 51], [125, 128, 135], [90, 58, 36], [220, 193, 120], [58, 116, 216],
        [184, 128, 60], [232, 224, 96], [63, 154, 58], [226, 71, 138], [255, 122, 28], [110, 112, 120],
        [207, 216, 230], [255, 0, 255], [224, 60, 20], [255, 0, 255],
    ];
    let mut f = std::fs::File::create(out).unwrap();
    let mut buf = Vec::with_capacity(s.grid.mat.len() * 3);
    for &m in &s.grid.mat {
        buf.extend_from_slice(&pal[m as usize]);
    }
    f.write_all(&buf).unwrap();
}

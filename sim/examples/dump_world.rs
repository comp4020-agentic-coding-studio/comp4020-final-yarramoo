//! Dev tool: `cargo run --release --example dump_world -- SEED SIZE PRESET out.ppm` writes the generated world as a
//! binary PPM (P6). SIZE is 0 (S), 1 (M) or 2 (L); PRESET is `pvp` or `survival`. Convert with `magick out.ppm out.png`.
//! The palette is the 32 entries of `paletteTable()` in client/materials.ts (unknown ids magenta).
#![allow(clippy::disallowed_methods)] // a dev timing tool, not part of the sim
use sim::config::RoomConfig;
use std::io::Write;

fn rgb(c: u32) -> [u8; 3] {
    [(c >> 16) as u8, (c >> 8) as u8, c as u8]
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let usage = "usage: dump_world SEED SIZE(0|1|2) PRESET(pvp|survival) out.ppm";
    if a.len() < 5 {
        panic!("{usage}");
    }
    let seed: u64 = a[1].parse().expect(usage);
    let size: u8 = a[2].parse().expect(usage);
    let base = match a[3].as_str() {
        "pvp" => RoomConfig::caves_pvp(),
        "survival" => RoomConfig::survival(),
        _ => panic!("{usage}"),
    };
    let cfg = RoomConfig { size, ..base };
    let t = std::time::Instant::now();
    let s = sim::sim::Sim::new(seed, cfg).expect("config");
    eprintln!("generated in {:?}", t.elapsed());
    let mut pal = [rgb(0xff00ff); 32];
    for (id, c) in [
        (0, 0x0b0e14), (1, 0x2b2d33), (2, 0x7d8087), (3, 0x5a3a24), (4, 0xdcc178), (5, 0x3a74d8), (6, 0xb8803c),
        (7, 0xe8e060), (8, 0x3f9a3a), (9, 0xe2478a), (10, 0xff7a1c), (11, 0x6e7078), (12, 0xcfd8e6), (13, 0x2e2e36),
        (14, 0xe03c14), (15, 0x6b4a14), (16, 0x8ad21c), (17, 0xb4c85a), (18, 0xa8e4f0), (19, 0xb4c4d4), (20, 0x1a1d28),
        (21, 0x8a8178),
    ] {
        pal[id] = rgb(c);
    }
    let (w, h) = (s.grid.w, s.grid.h);
    let mut f = std::fs::File::create(&a[4]).unwrap();
    f.write_all(format!("P6\n{w} {h}\n255\n").as_bytes()).unwrap();
    let mut buf = Vec::with_capacity(w * h * 3);
    for &m in &s.grid.mat {
        buf.extend_from_slice(&pal[usize::from(m).min(31)]);
    }
    f.write_all(&buf).unwrap();
}

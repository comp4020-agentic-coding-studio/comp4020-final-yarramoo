#![allow(clippy::disallowed_methods)] // dev timing tool, not part of the sim
//! G2 P1 worst case, native: `cargo run --release --features dev_paint --example p1_bench`.
//! Four players 600 cells apart (same layout as tests/soak/p1.ts), each with a fire and a water flood.
//! Prints step p50/p95 over 1200 ticks after a 300-tick warm-up, a phase estimate timed from outside
//! (`set_active_around` and an equal-size buffer fill are replayed; see docs/research/g2-results.md),
//! and the state hash every 60th tick, so a change can be shown bit-identical (`HASHES=1` prints them all).
use sim::input::{encode_join, encode_paint, encode_pos};
use sim::sim::Sim;
use std::time::Instant;

fn pct(v: &[f64], p: f64) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    s[((s.len() as f64) * p) as usize].min(s[s.len() - 1])
}

fn main() {
    let mut s = Sim::new(20261014, 1).unwrap();
    let xs = [250i32, 850, 1450, 1950];
    let y = 230i32;
    for id in 1..=4u32 {
        s.push_input(&encode_join(id));
    }
    s.step();
    for (i, x) in xs.iter().enumerate() {
        s.push_input(&encode_pos(i as u32 + 1, 0, x * 16, y * 16, 0));
    }
    s.step();
    let (wood, fire, water, gunp) = (6u8, 10u8, 5u8, 13u8);
    let paint = |s: &mut Sim, m: u8, x0: i32, y0: i32, x1: i32, y1: i32, r: u8| {
        s.push_input(&encode_paint(0, m, x0 as i16, y0 as i16, x1 as i16, y1 as i16, r));
    };
    for &x in &xs {
        paint(&mut s, wood, x - 60, y - 20, x + 60, y - 20, 14);
        paint(&mut s, gunp, x - 40, y - 20, x + 40, y - 20, 6);
        paint(&mut s, fire, x - 60, y - 34, x + 60, y - 34, 5);
        paint(&mut s, fire, x - 60, y - 6, x + 60, y - 6, 5);
        for dy in [-70, -100, -130] {
            paint(&mut s, water, x - 80, y + dy, x + 80, y + dy, 32);
        }
    }
    let centres: Vec<(i32, i32)> = xs.iter().map(|x| (*x, y)).collect();
    let mut scratch = vec![0u8; s.grid.w * s.grid.h];
    let (mut step, mut fill, mut act, mut chunks) = (vec![], vec![], vec![], vec![]);
    let all = std::env::var("HASHES").is_ok();
    let mut hashes = Vec::new();
    for t in 0..1500u32 {
        if t % 2 == 0 {
            for (i, x) in xs.iter().enumerate() {
                s.push_input(&encode_pos(i as u32 + 1, 0, x * 16, y * 16, (i & 1) as u8));
            }
        }
        let t0 = Instant::now();
        s.step();
        let dt = t0.elapsed().as_secs_f64() * 1000.0;
        if t >= 300 {
            step.push(dt);
            chunks.push(f64::from(s.grid.ran_chunks));
            let t1 = Instant::now();
            scratch.fill((t & 1) as u8);
            std::hint::black_box(&scratch);
            fill.push(t1.elapsed().as_secs_f64() * 1000.0);
            let t2 = Instant::now();
            s.grid.set_active_around(&centres);
            act.push(t2.elapsed().as_secs_f64() * 1000.0);
        }
        if t % 60 == 59 && (all || t >= 1499) {
            hashes.push((s.tick, s.state_hash()));
        }
    }
    println!("step     p50 {:.3} ms  p95 {:.3} ms  mean chunks {:.1}", pct(&step, 0.5), pct(&step, 0.95), chunks.iter().sum::<f64>() / chunks.len() as f64);
    println!("moved.fill-equivalent (3.1 MB) p50 {:.3} ms  p95 {:.3} ms", pct(&fill, 0.5), pct(&fill, 0.95));
    println!("set_active_around              p50 {:.3} ms  p95 {:.3} ms", pct(&act, 0.5), pct(&act, 0.95));
    for (t, h) in hashes {
        println!("hash {t} {h:016x}");
    }
}

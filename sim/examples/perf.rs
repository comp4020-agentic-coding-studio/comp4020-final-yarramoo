#![allow(clippy::disallowed_methods)] // dev timing tool, not part of the sim
//! `cargo run --release --example perf`: step-time p50/p95 for the game world, native.
use sim::sim::Sim;
use std::time::Instant;

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64) * p) as usize].min(v[v.len() - 1])
}

fn run(label: &str, sleep: bool, disturb: bool) {
    let mut s = Sim::new(1, 1).unwrap();
    s.grid.sleep_enabled = sleep;
    let w = s.grid.w;
    let mut times = Vec::new();
    let mut ran = 0;
    for t in 0..1500u32 {
        if disturb && t == 400 {
            // A flood and a fire inside the camera's reach of the first entrance shaft (about x 780, y 300).
            for dx in 0..40 {
                for dy in 0..30 {
                    let i = (280 + dy) * w + 760 + dx;
                    if s.grid.mat[i] == 0 {
                        s.grid.set(i, 5, 0);
                    }
                }
            }
            for dx in 0..60 {
                let i = (225) * w + 700 + dx;
                if s.grid.mat[i] == 0 {
                    s.grid.set(i, 10, 0);
                }
            }
        }
        let t0 = Instant::now();
        s.step();
        let dt = t0.elapsed().as_secs_f64() * 1000.0;
        if t >= 300 {
            times.push(dt);
            ran += s.grid.ran_chunks as usize;
        }
    }
    let avg = ran / times.len();
    println!("{label:42} p50 {:.2} ms  p95 {:.2} ms  (avg {avg} chunks run)", pct(&mut times.clone(), 0.5), pct(&mut times, 0.95));
}

fn main() {
    run("rest, all chunks active, sleeping ON", true, false);
    run("rest, all chunks active, sleeping OFF", false, false);
    run("flood + fire, sleeping ON", true, true);
    run("flood + fire, sleeping OFF", false, true);
}

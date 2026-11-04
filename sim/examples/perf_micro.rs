#![allow(clippy::disallowed_methods)] // dev timing tool, not part of the sim
//! Perf micro-benchmarks (5 Nov): `cargo run --release --example perf_micro [name]`.
//! Each case rebuilds an identical starting state, times one isolated function, and repeats; the figure printed
//! is the MINIMUM over the repeats (robust to a loaded machine: load only ever adds time), with the median beside it.
//! A checksum of the end state is printed so two builds can be seen to do the same work.
use sim::grid::Grid;
use sim::materials::*;
use sim::sim::Sim;
use std::time::Instant;

fn stats(mut v: Vec<f64>) -> (f64, f64) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (v[0], v[v.len() / 2])
}

fn sum(g: &Grid) -> u64 {
    g.mat.iter().zip(&g.aux).enumerate().fold(0u64, |a, (i, (&m, &x))| a.wrapping_mul(31).wrapping_add((i as u64) ^ (m as u64) << 8 ^ x as u64))
}

/// 512x512: rock floor and shelves, a sand band, a water band, air above. Busy for the whole run.
fn sand_water() -> Grid {
    let mut g = Grid::new(512, 512);
    let w = 512;
    for y in 0..512 {
        for x in 0..512 {
            let m = if y >= 500 || x < 4 || x >= 508 {
                ROCK
            } else if (y == 350 && x % 128 < 90) || (y == 420 && x % 96 > 30) {
                ROCK
            } else if (100..180).contains(&y) {
                SAND
            } else if (200..300).contains(&y) {
                WATER
            } else {
                EMPTY
            };
            if m != EMPTY {
                g.set(y * w + x, m, 0);
            }
        }
    }
    g
}

/// Mostly air and rock with a little sand: the quiet-cell case (awake chunks mostly inert).
fn sparse() -> Grid {
    let mut g = Grid::new(512, 512);
    let w = 512;
    for y in 0..512 {
        for x in 0..512 {
            let m = if y >= 300 { ROCK } else if y < 40 && x % 64 == 7 { SAND } else { EMPTY };
            if m != EMPTY {
                g.set(y * w + x, m, 0);
            }
        }
    }
    g.sleep_enabled = false; // every chunk runs every tick: measures the per-cell floor
    g
}

fn bench_cells(label: &str, make: fn() -> Grid, ticks: u32, reps: usize) {
    let mut times = Vec::new();
    let mut check = 0;
    for _ in 0..reps {
        let mut g = make();
        let t0 = Instant::now();
        for t in 0..ticks {
            g.step_cells(9, t);
        }
        times.push(t0.elapsed().as_secs_f64() * 1000.0 / ticks as f64);
        check = sum(&g);
    }
    let (min, med) = stats(times);
    println!("{label:<28} min {min:8.4} ms/tick  median {med:8.4}  ({reps} reps x {ticks} ticks)  check {check:016x}");
}

fn bench_touch(reps: usize) {
    let mut g = Grid::new(2048, 1536);
    let n = g.w * g.h;
    let mut times = Vec::new();
    for _ in 0..reps {
        let t0 = Instant::now();
        // A strided walk that visits chunk interiors and edges alike.
        let mut i = 0usize;
        for _ in 0..4_000_000 {
            g.touch(i);
            i = (i + 7919) % n;
        }
        times.push(t0.elapsed().as_secs_f64() * 1e9 / 4_000_000.0);
    }
    let (min, med) = stats(times);
    println!("{:<28} min {min:8.3} ns/call  median {med:8.3}", "touch (2048x1536)");
}

fn bench_snapshot(reps: usize) {
    let mut cfg = sim::config::RoomConfig::survival();
    cfg.size = 2;
    let mut s = Sim::new(1, cfg).unwrap();
    s.push_input(&sim::input::encode_join(1));
    s.step();
    let mut times = Vec::new();
    let mut len = 0;
    for _ in 0..reps {
        let t0 = Instant::now();
        // The ABI sequence: snapshot_size, then snapshot_write.
        let n = sim::snapshot::size(&s);
        let v = sim::snapshot::write(&s);
        assert_eq!(n, v.len());
        len = v.len();
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    let (min, med) = stats(times);
    println!("{:<28} min {min:8.3} ms  median {med:8.3}  ({len} bytes)", "snapshot size+write (L)");
}

fn main() {
    let which = std::env::args().nth(1).unwrap_or_default();
    let on = |n: &str| which.is_empty() || which == n;
    if on("cells") {
        bench_cells("step_cells sand+water 512", sand_water, 200, 15);
        bench_cells("step_cells sparse 512", sparse, 200, 15);
    }
    if on("touch") {
        bench_touch(15);
    }
    if on("snapshot") {
        bench_snapshot(15);
    }
}

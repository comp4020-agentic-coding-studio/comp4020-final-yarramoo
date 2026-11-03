#![allow(clippy::disallowed_methods)] // dev timing tool, not part of the sim
//! Brief W load test: `cargo run --release --example wake_load [scenario]` (scenario 1..5, default all).
//! Size-L Survival world, one player at the surface, 18000 ticks (5 minutes). Disturbance at tick 600; stats
//! cover ticks 600.. so the baseline is measured over the same window. Prints step p50/p95/max (ms, native),
//! chunks run per tick (mean, peak), peak woken frozen chunks and the tick the last woken chunk froze.
use sim::config::RoomConfig;
use sim::input::{encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;
use std::time::Instant;

const TICKS: u32 = 18000;
const DISTURB: u32 = 600;

fn pct(v: &[f64], p: f64) -> f64 {
    let mut v = v.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[(((v.len() as f64) * p) as usize).min(v.len() - 1)]
}

fn surface(s: &Sim, x: usize) -> usize {
    (0..s.grid.h).find(|&y| s.grid.mat[y * s.grid.w + x] != EMPTY).unwrap_or(0)
}

/// Fill the EMPTY cells of a rectangle with `m`.
fn fill(s: &mut Sim, x0: usize, x1: usize, y0: usize, y1: usize, m: u8) -> usize {
    let w = s.grid.w;
    let mut n = 0;
    for y in y0..y1 {
        for x in x0..x1 {
            if s.grid.mat[y * w + x] == EMPTY {
                s.grid.set(y * w + x, m, 0);
                n += 1;
            }
        }
    }
    n
}

fn disturb(s: &mut Sim, scenario: u32, px: usize, py: usize) -> String {
    let w = s.grid.w;
    match scenario {
        1 => "none".into(),
        2 => {
            // A flood across the surface, 400 wide and 60 tall, resting on the ground around the player.
            let n = fill(s, px - 200, px + 200, py.saturating_sub(60), py + 5, WATER);
            format!("{n} water cells on the surface")
        }
        3 | 4 => {
                        if scenario == 3 {
                // Fire on every Wood or Flower/Stem cell within 400 columns of the player, near the surface.
                let mut lit = 0;
                for y in py.saturating_sub(80)..py + 40 {
                    for x in px - 400..px + 400 {
                        let i = y * w + x;
                        if matches!(s.grid.mat[i], WOOD | STEM | FLOWER) {
                            for (dx, dy) in [(0isize, -1isize), (0, 1), (-1, 0), (1, 0)] {
                                let j = ((y as isize + dy) as usize) * w + (x as isize + dx) as usize;
                                if s.grid.mat[j] == EMPTY {
                                    s.grid.set(j, FIRE, 0);
                                    lit += 1;
                                    break;
                                }
                            }
                        }
                    }
                }
                let count = |m: u8| s.grid.mat.iter().filter(|&&c| c == m).count();
                format!("{lit} fire cells beside fuel (world has {} wood, {} stem, {} flower, {} seed)", count(WOOD), count(STEM), count(FLOWER), count(SEED))
            } else {
                // Lava poured into the nearest cave air below the player: 40 x 25 block of the EMPTY cells.
                let mut at = None;
                'o: for y in py + 60..py + 400 {
                    for x in px - 150..px + 150 {
                        if s.grid.mat[y * w + x] == EMPTY && s.grid.mat[(y + 1) * w + x] != EMPTY {
                            at = Some((x, y));
                            break 'o;
                        }
                    }
                }
                let (x, y) = at.expect("no cave floor near the player");
                let n = fill(s, x.saturating_sub(20), x + 20, y.saturating_sub(25), y + 1, LAVA);
                format!("{n} lava cells in a cave at ({x},{y})")
            }
        }
        _ => {
            // Worst case: a 6-cell sheet of water and a 6-cell sheet of lava across the whole width, high above
            // the surface, falling onto it and draining down every chasm.
            let y = py.saturating_sub(100);
            let a = fill(s, 8, w - 8, y, y + 6, WATER);
            let b = fill(s, 8, w - 8, y + 6, y + 12, LAVA);
            format!("{a} water + {b} lava cells across the full width")
        }
    }
}

fn run(scenario: u32, label: &str) {
    let mut cfg = RoomConfig::survival();
    cfg.size = 2;
    let mut s = Sim::new(1, cfg).unwrap();
    let (px, py) = (1024usize, 0usize);
    let py = surface(&s, px) + py;
    let pos = encode_pos(1, 0, (px as i32) * 16, ((py as i32) - 4) * 16, 0);
    s.push_input(&encode_join(1));
    let (mut times, mut ran) = (Vec::new(), Vec::new());
    let (mut peak_woken, mut last_woken, mut total_woken) = (0u32, 0u32, 0u64);
    let mut note = String::new();
    for t in 0..TICKS {
        if t % 60 == 0 {
            s.push_input(&pos);
        }
        if t == DISTURB {
            note = disturb(&mut s, scenario, px, py);
        }
        let t0 = Instant::now();
        s.step();
        let dt = t0.elapsed().as_secs_f64() * 1000.0;
        if t >= DISTURB {
            times.push(dt);
            ran.push(s.grid.ran_chunks);
            let wk = s.grid.woken_frozen();
            peak_woken = peak_woken.max(wk);
            total_woken += u64::from(wk);
            if wk > 0 {
                last_woken = t;
            }
        }
    }
    let mean_ran = ran.iter().map(|&r| u64::from(r)).sum::<u64>() as f64 / ran.len() as f64;
    let peak_ran = ran.iter().max().unwrap();
    let back = if last_woken + 1 >= TICKS { "never".to_string() } else { format!("{}", last_woken + 1) };
    println!(
        "{label:34} p50 {:.2}  p95 {:.2}  max {:.2} ms | chunks run mean {:.1} peak {} | woken peak {} mean {:.1} | woken back to 0 at tick {} | {note}",
        pct(&times, 0.5),
        pct(&times, 0.95),
        times.iter().cloned().fold(0.0, f64::max),
        mean_ran,
        peak_ran,
        peak_woken,
        total_woken as f64 / times.len() as f64,
        back,
    );
}

fn main() {
    let only: Option<u32> = std::env::args().nth(1).and_then(|a| a.parse().ok());
    let names = ["", "1 baseline (no disturbance)", "2 surface flood", "3 forest fire", "4 lava in a cave", "5 worst: full-width water + lava"];
    for k in 1..=5u32 {
        if only.is_none_or(|o| o == k) {
            run(k, names[k as usize]);
        }
    }
}

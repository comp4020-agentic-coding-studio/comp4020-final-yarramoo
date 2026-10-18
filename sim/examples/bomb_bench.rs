#![allow(clippy::disallowed_methods)] // dev timing tool, not part of the sim
//! One tick with `MAX_BOMB_EXPLOSIONS_PER_TICK` bombs exploding in rock at once, native:
//! `cargo run --release --example bomb_bench`. Prints min/median/max step time over 30 repeats.
use sim::entities::Projectile;
use sim::input::{encode_join, encode_pos};
use sim::materials::ROCK;
use sim::sim::Sim;
use sim::tuning::*;
use std::time::Instant;

fn main() {
    let mut times = vec![];
    for rep in 0..30u32 {
        let mut s = Sim::new(7 + u64::from(rep), 1).unwrap();
        s.push_input(&encode_join(1));
        s.step();
        s.push_input(&encode_pos(1, 0, 100 * 16, 100 * 16, 0));
        s.step();
        let w = s.grid.w;
        for y in 300..700 {
            for x in 200..1000 {
                s.grid.set(y * w + x, ROCK, 0);
            }
        }
        // Eight bombs in a solid rock mass, 60 cells apart so their discs do not overlap.
        for i in 0..8i32 {
            s.projectiles.push(Projectile { owner: 1, spell: 5, cast_seq: i as u16, x: (260 + 90 * i) << 8, y: 500 << 8, vx: 0, vy: 0, age: BOMB_FUSE - 1 });
        }
        let t0 = Instant::now();
        s.step();
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("8-bomb tick: min {:.3} ms  median {:.3} ms  max {:.3} ms", times[0], times[15], times[29]);
}

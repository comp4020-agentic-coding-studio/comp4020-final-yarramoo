//! The simulation instance: grid + tick + queued inputs.

use crate::grid::Grid;
use crate::hash;
use crate::input::{decode, Input};
use crate::materials::*;

pub const SANDBOX_W: usize = 512;
pub const SANDBOX_H: usize = 512;
pub const GAME_W: usize = 2048;
pub const GAME_H: usize = 1536;
const FLOOR_ROWS: usize = 16;
const WALL_COLS: usize = 16;
pub const MAX_PAINT_RADIUS: i32 = 32;

pub struct Sim {
    pub seed: u64,
    pub world_kind: u8,
    pub tick: u32,
    pub grid: Grid,
    queue: Vec<Input>,
    /// Floor positions for pickups (game worlds). Not state: regenerated from the seed, never hashed
    /// or snapshotted. M4 places pickup entities here.
    pub spots: Vec<crate::gen::PickupSpot>,
}

impl Sim {
    /// Generate a world, tick = 0. Returns None for an unknown `world_kind`.
    pub fn new(seed: u64, world_kind: u8) -> Option<Sim> {
        let (w, h) = match world_kind {
            0 => (SANDBOX_W, SANDBOX_H),
            1 => (GAME_W, GAME_H),
            _ => return None,
        };
        let mut grid = Grid::new(w, h);
        if world_kind == 1 {
            let spots = crate::gen::generate(&mut grid, seed);
            return Some(Sim { seed, world_kind, tick: 0, grid, queue: Vec::new(), spots });
        }
        for y in 0..h {
            for x in 0..w {
                if y >= h - FLOOR_ROWS || x < WALL_COLS || x >= w - WALL_COLS {
                    grid.mat[y * w + x] = BEDROCK;
                }
            }
        }
        Some(Sim { seed, world_kind, tick: 0, grid, queue: Vec::new(), spots: Vec::new() })
    }

    /// 0 on success, negative if malformed (input is then dropped).
    pub fn push_input(&mut self, bytes: &[u8]) -> i32 {
        match decode(bytes) {
            Ok(i) => {
                self.queue.push(i);
                0
            }
            Err(()) => -1,
        }
    }

    pub fn step(&mut self) -> u32 {
        let inputs = core::mem::take(&mut self.queue);
        for i in inputs {
            self.apply(i);
        }
        self.refresh_active();
        self.grid.step_cells(self.seed, self.tick);
        #[cfg(feature = "canary")]
        {
            // Test D10: the only host import. Must make the build fail the zero-imports check.
            extern "C" {
                fn canary_value() -> u32;
            }
            // SAFETY: canary-only test hook; the host provides this function.
            let v = unsafe { canary_value() } & 1;
            let i = 20 * self.grid.w + 100;
            self.grid.set(i, if v == 1 { SAND } else { EMPTY }, 0);
        }
        self.tick = self.tick.wrapping_add(1);
        self.tick
    }

    /// Plan 6.5 active set. Sandbox: every chunk. Game world: chunks near active players; there are no
    /// players until M4, so for now an empty list means everything is active (D-053, temporary).
    fn refresh_active(&mut self) {
        let centres: Vec<(i32, i32)> = Vec::new(); // M4: official positions of active players
        if self.world_kind == 0 || centres.is_empty() {
            self.grid.set_all_active();
        } else {
            self.grid.set_active_around(&centres);
        }
    }

    fn apply(&mut self, i: Input) {
        match i {
            Input::Paint { mat, x0, y0, x1, y1, radius, .. } => {
                if self.world_kind == 0 {
                    self.paint(mat, x0 as i32, y0 as i32, x1 as i32, y1 as i32, radius as i32);
                }
            }
            // Entities arrive in a later milestone; accepted and ignored for now.
            Input::Join { .. } | Input::Leave { .. } | Input::Pos { .. } | Input::Cast { .. } => {}
        }
    }

    fn paint(&mut self, mat: u8, x0: i32, y0: i32, x1: i32, y1: i32, r: i32) {
        if !paintable(mat) {
            return;
        }
        // Clamping bounds the work one input can cost every client, and keeps the line maths in range.
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        let (x0, x1) = (x0.clamp(0, w - 1), x1.clamp(0, w - 1));
        let (y0, y1) = (y0.clamp(0, h - 1), y1.clamp(0, h - 1));
        let r = r.min(MAX_PAINT_RADIUS);
        let (dx, dy) = (x1 - x0, y1 - y0);
        let n = dx.abs().max(dy.abs());
        for k in 0..=n {
            let (cx, cy) = if n == 0 { (x0, y0) } else { (x0 + dx * k / n, y0 + dy * k / n) };
            self.disc(mat, cx, cy, r);
        }
    }

    fn disc(&mut self, mat: u8, cx: i32, cy: i32, r: i32) {
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        for y in (cy - r).max(0)..=(cy + r).min(h - 1) {
            for x in (cx - r).max(0)..=(cx + r).min(w - 1) {
                let (ax, ay) = (x - cx, y - cy);
                if ax * ax + ay * ay > r * r {
                    continue;
                }
                let i = (y * w + x) as usize;
                if self.grid.mat[i] == BEDROCK {
                    continue;
                }
                self.grid.set(i, mat, 0);
            }
        }
    }

    pub fn entity_bytes(&self) -> Vec<u8> {
        Vec::new()
    }

    pub fn state_hash(&mut self) -> u64 {
        let e = self.entity_bytes();
        hash::state_hash(&mut self.grid, self.tick, &e)
    }
}

//! Rigid bodies v1 (experiment x-bodies): a cut-free island lifted out of the grid falls as one piece, then
//! rasterises back where it rests. Translation only, fixed point, integers only. State: hashed and snapshotted.
//!
//! Bounds: at most `MAX_BODIES` bodies, each at most `ISLAND_MAX` cells inside a `BODY_BBOX_MAX` square, at most
//! `MAX_SUBSTEPS` one-cell moves a tick, each testing every cell once (so about 8 * 6 * 400 reads a tick worst case).

use crate::grid::CHUNK;
use crate::materials::*;
use crate::sim::Sim;
use crate::tuning::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Body {
    /// Top-left of the bounding box, in 1/16 cell.
    pub x: i32,
    pub y: i32,
    /// 1/16 cell per tick. `vx` stays 0 in v1 (nothing pushes a body sideways yet) but is hashed for the next step.
    pub vx: i16,
    pub vy: i16,
    /// (dx, dy, mat, aux) relative to the box corner, sorted by (dy, dx), no duplicates.
    pub cells: Vec<(u8, u8, u8, u8)>,
}

pub const BODY_HEAD: usize = 4 + 4 + 2 + 2 + 2;

impl Body {
    pub fn write(&self, v: &mut Vec<u8>) {
        v.extend_from_slice(&self.x.to_le_bytes());
        v.extend_from_slice(&self.y.to_le_bytes());
        v.extend_from_slice(&self.vx.to_le_bytes());
        v.extend_from_slice(&self.vy.to_le_bytes());
        v.extend_from_slice(&(self.cells.len() as u16).to_le_bytes());
        for &(dx, dy, m, a) in &self.cells {
            v.extend_from_slice(&[dx, dy, m, a]);
        }
    }
}

/// `n u32` then the bodies. Empty list is 4 zero bytes.
pub fn encode(bodies: &[Body]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(bodies.len() as u32).to_le_bytes());
    for b in bodies {
        b.write(&mut v);
    }
    v
}

/// Decode the bodies at the front of `b`; returns them and the bytes consumed. Hostile input fails cleanly.
pub fn decode(b: &[u8], w: usize, h: usize) -> Result<(Vec<Body>, usize), ()> {
    let n = u32::from_le_bytes(b.get(0..4).ok_or(())?.try_into().map_err(|_| ())?) as usize;
    if n > MAX_BODIES {
        return Err(());
    }
    let mut o = 4;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let head = b.get(o..o + BODY_HEAD).ok_or(())?;
        let x = i32::from_le_bytes([head[0], head[1], head[2], head[3]]);
        let y = i32::from_le_bytes([head[4], head[5], head[6], head[7]]);
        let vx = i16::from_le_bytes([head[8], head[9]]);
        let vy = i16::from_le_bytes([head[10], head[11]]);
        let nc = u16::from_le_bytes([head[12], head[13]]) as usize;
        o += BODY_HEAD;
        if nc == 0 || nc >= ISLAND_MAX {
            return Err(());
        }
        let raw = b.get(o..o + 4 * nc).ok_or(())?;
        o += 4 * nc;
        let cells: Vec<(u8, u8, u8, u8)> = raw.chunks_exact(4).map(|c| (c[0], c[1], c[2], c[3])).collect();
        let sorted = cells.windows(2).all(|p| (p[0].1, p[0].0) < (p[1].1, p[1].0));
        let (mx, my) = cells.iter().fold((0usize, 0usize), |a, c| (a.0.max(usize::from(c.0)), a.1.max(usize::from(c.1))));
        let ok = sorted
            && mx < BODY_BBOX_MAX
            && my < BODY_BBOX_MAX
            && cells.iter().all(|c| c.2 != EMPTY && c.2 <= PEBBLES)
            && x >= 0
            && y >= 0
            && (x >> POS_SHIFT) as usize + mx < w
            && (y >> POS_SHIFT) as usize + my < h
            && i32::from(vy) <= BODY_MAX_VY
            && vy >= 0;
        if !ok {
            return Err(());
        }
        out.push(Body { x, y, vx, vy, cells });
    }
    Ok((out, o))
}

impl Sim {
    /// Does `body` at cell origin (cx, cy) overlap a solid cell, the world edge, or a living avatar/enemy?
    fn body_blocked(&self, body: &Body, cx: i32, cy: i32) -> bool {
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        let (mut mx, mut my) = (0i32, 0i32);
        for &(dx, dy, _, _) in &body.cells {
            let (x, y) = (cx + i32::from(dx), cy + i32::from(dy));
            if x < 0 || y < 0 || x >= w || y >= h || blocks_enemy(self.grid.mat[(y * w + x) as usize]) {
                return true;
            }
            mx = mx.max(i32::from(dx));
            my = my.max(i32::from(dy));
        }
        // Players and enemies block it (no crush in v1): compare the box first, then the cells.
        let boxes = self.players.iter().filter(|p| p.alive(self.tick)).map(|p| p.hitbox_cells()).chain(self.enemies.iter().map(|e| e.hitbox_cells()));
        for (x0, y0, x1, y1) in boxes {
            if x1 < cx || x0 > cx + mx || y1 < cy || y0 > cy + my {
                continue;
            }
            if body.cells.iter().any(|&(dx, dy, _, _)| {
                let (x, y) = (cx + i32::from(dx), cy + i32::from(dy));
                x >= x0 && x <= x1 && y >= y0 && y <= y1
            }) {
                return true;
            }
        }
        false
    }

    /// Step every body in id (list) order. A body whose centre chunk is not `active` is frozen by rule (never
    /// reads `awake`). Runs inside `update_entities`, after the tick's `refresh_active`.
    pub(crate) fn update_bodies(&mut self) {
        let mut k = 0;
        while k < self.bodies.len() {
            let landed = self.step_body(k);
            if landed {
                let b = self.bodies.remove(k);
                self.land(&b);
            } else {
                k += 1;
            }
        }
    }

    fn step_body(&mut self, k: usize) -> bool {
        let b = self.bodies[k].clone();
        let (mut mx, mut my) = (0i32, 0i32);
        for &(dx, dy, _, _) in &b.cells {
            mx = mx.max(i32::from(dx));
            my = my.max(i32::from(dy));
        }
        let (ccx, ccy) = ((b.x >> POS_SHIFT) + mx / 2, (b.y >> POS_SHIFT) + my / 2);
        let c = self.grid.chunk_of(ccx.clamp(0, self.grid.w as i32 - 1) as usize, ccy.clamp(0, self.grid.h as i32 - 1) as usize);
        debug_assert!(CHUNK > 0);
        if !self.grid.active[c] {
            return false;
        }
        let vy = (i32::from(b.vy) + BODY_GRAVITY).min(BODY_MAX_VY);
        let target = b.y + vy;
        let mut y = b.y;
        let cx = b.x >> POS_SHIFT;
        let mut landed = false;
        // One cell at a time (the DDA): terminal speed is under `MAX_SUBSTEPS` cells a tick.
        for _ in 0..MAX_SUBSTEPS {
            if (y >> POS_SHIFT) >= (target >> POS_SHIFT) {
                break;
            }
            if self.body_blocked(&b, cx, (y >> POS_SHIFT) + 1) {
                landed = true;
                break;
            }
            y = ((y >> POS_SHIFT) + 1) << POS_SHIFT;
        }
        if !landed {
            // Sub-cell remainder inside the current row: only moves if the row is still the same.
            if (y >> POS_SHIFT) >= (target >> POS_SHIFT) {
                y = target.max(y);
            }
        } else {
            y &= !(POS_ONE - 1);
        }
        let nb = &mut self.bodies[k];
        nb.y = y;
        nb.vy = if landed { 0 } else { vy as i16 };
        landed
    }

    /// Rasterise a resting body. Cells that land on a solid (the world changed under it) are dropped; fluids and
    /// gases are overwritten (destroyed). Writes are unseeded so a landing never triggers a flood, and `touch` wakes
    /// the chunks it crosses.
    fn land(&mut self, b: &Body) {
        let (cx, cy) = (b.x >> POS_SHIFT, b.y >> POS_SHIFT);
        let w = self.grid.w;
        for &(dx, dy, m, a) in &b.cells {
            let (x, y) = (cx + i32::from(dx), cy + i32::from(dy));
            if x < 0 || y < 0 || x as usize >= w || y as usize >= self.grid.h {
                continue;
            }
            let i = y as usize * w + x as usize;
            if blocks_enemy(self.grid.mat[i]) {
                continue;
            }
            self.grid.set_unseeded(i, m, a);
        }
    }

    /// Turn the islands `crumble_islands` lifted this tick into bodies, in the order they were found.
    pub(crate) fn adopt_lifted(&mut self) {
        let w = self.grid.w;
        for cells in core::mem::take(&mut self.grid.lifted) {
            let (mut x0, mut y0) = (usize::MAX, usize::MAX);
            for &(c, _, _) in &cells {
                x0 = x0.min(c as usize % w);
                y0 = y0.min(c as usize / w);
            }
            let mut v: Vec<(u8, u8, u8, u8)> =
                cells.iter().map(|&(c, m, a)| ((c as usize % w - x0) as u8, (c as usize / w - y0) as u8, m, a)).collect();
            v.sort_unstable_by_key(|c| (c.1, c.0));
            self.bodies.push(Body { x: (x0 as i32) << POS_SHIFT, y: (y0 as i32) << POS_SHIFT, vx: 0, vy: 0, cells: v });
        }
    }
}

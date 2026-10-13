//! World grid, chunk metadata and the cell update (plan 6.1, 6.2, 6.4).

use crate::materials::*;
use crate::rng::*;

pub const CHUNK: usize = 64;
pub const CHUNK_AREA: usize = CHUNK * CHUNK;

pub struct Grid {
    pub w: usize,
    pub h: usize,
    pub cw: usize,
    pub ch: usize,
    pub mat: Vec<u8>,
    pub aux: Vec<u8>,
    /// Scratch, not state: one byte per cell, cleared each tick.
    moved: Vec<u8>,
    pub dirty_since_hash: Vec<bool>,
    pub hash_cache: Vec<u64>,
    pub pristine: Vec<bool>,
    /// Test hook (D7). Sleeping is not implemented yet; all chunks are always active.
    pub sleep_enabled: bool,
}

impl Grid {
    pub fn new(w: usize, h: usize) -> Grid {
        let (cw, ch) = (w / CHUNK, h / CHUNK);
        Grid {
            w,
            h,
            cw,
            ch,
            mat: vec![EMPTY; w * h],
            aux: vec![0; w * h],
            moved: vec![0; w * h],
            dirty_since_hash: vec![true; cw * ch],
            hash_cache: vec![0; cw * ch],
            pristine: vec![true; cw * ch],
            sleep_enabled: false,
        }
    }

    pub fn chunk_count(&self) -> usize {
        self.cw * self.ch
    }

    pub fn chunk_of(&self, x: usize, y: usize) -> usize {
        (y / CHUNK) * self.cw + x / CHUNK
    }

    /// Record that the cell at flat index `i` changed.
    pub fn touch(&mut self, i: usize) {
        let c = self.chunk_of(i % self.w, i / self.w);
        self.dirty_since_hash[c] = true;
        self.pristine[c] = false;
    }

    pub fn mark_chunk(&mut self, c: usize) {
        self.dirty_since_hash[c] = true;
        self.pristine[c] = false;
    }

    pub fn set(&mut self, i: usize, m: u8, a: u8) {
        self.mat[i] = m;
        self.aux[i] = a;
        self.touch(i);
    }

    fn swap(&mut self, a: usize, b: usize) {
        self.mat.swap(a, b);
        self.aux.swap(a, b);
        self.moved[a] = 1;
        self.moved[b] = 1;
        self.touch(a);
        self.touch(b);
    }

    /// Advance every cell one tick in the fixed order of plan 6.2 step 3.
    pub fn step_cells(&mut self, seed: u64, tick: u32) {
        self.moved.fill(0);
        let odd = tick & 1 == 1;
        for cy in (0..self.ch).rev() {
            for ci in 0..self.cw {
                let cx = if odd { self.cw - 1 - ci } else { ci };
                for y in (cy * CHUNK..cy * CHUNK + CHUNK).rev() {
                    for xi in 0..CHUNK {
                        let x = cx * CHUNK + if odd { CHUNK - 1 - xi } else { xi };
                        self.update_cell(x, y, seed, tick);
                    }
                }
            }
        }
    }

    fn update_cell(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        let i = y * self.w + x;
        if self.moved[i] != 0 {
            return;
        }
        match self.mat[i] {
            SAND => self.update_sand(x, y, seed, tick),
            WATER => self.update_water(x, y, seed, tick),
            FIRE => self.update_fire(x, y, seed, tick),
            _ => {}
        }
    }

    fn at(&self, x: usize, y: usize) -> u8 {
        self.mat[y * self.w + x]
    }

    /// Cell (x+dx, y+dy) if in bounds.
    fn off(&self, x: usize, y: usize, dx: isize, dy: isize) -> Option<(usize, usize)> {
        let nx = x as isize + dx;
        let ny = y as isize + dy;
        if nx < 0 || ny < 0 || nx >= self.w as isize || ny >= self.h as isize {
            None
        } else {
            Some((nx as usize, ny as usize))
        }
    }

    /// Try to move (x,y) to (x+dx,y+dy) if the target material satisfies `ok`.
    fn try_move(
        &mut self,
        x: usize,
        y: usize,
        dx: isize,
        dy: isize,
        ok: fn(u8) -> bool,
    ) -> bool {
        if let Some((nx, ny)) = self.off(x, y, dx, dy) {
            if ok(self.at(nx, ny)) {
                self.swap(y * self.w + x, ny * self.w + nx);
                return true;
            }
        }
        false
    }

    fn update_sand(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        fn ok(m: u8) -> bool {
            m == EMPTY || m == WATER
        }
        if self.try_move(x, y, 0, 1, ok) {
            return;
        }
        let d = if rng(seed, tick, x as u32, y as u32, SALT_SAND_DIAG) & 1 == 0 { -1 } else { 1 };
        if self.try_move(x, y, d, 1, ok) {
            return;
        }
        self.try_move(x, y, -d, 1, ok);
    }

    fn update_water(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        fn ok(m: u8) -> bool {
            m == EMPTY
        }
        if self.try_move(x, y, 0, 1, ok) {
            return;
        }
        let d = if rng(seed, tick, x as u32, y as u32, SALT_WATER_DIAG) & 1 == 0 { -1 } else { 1 };
        if self.try_move(x, y, d, 1, ok) || self.try_move(x, y, -d, 1, ok) {
            return;
        }
        let s = if rng(seed, tick, x as u32, y as u32, SALT_WATER_SIDE) & 1 == 0 { -1 } else { 1 };
        if self.try_move(x, y, s, 0, ok) {
            return;
        }
        self.try_move(x, y, -s, 0, ok);
    }

    /// Fire: `aux` holds remaining lifetime (30..=90). `aux == 0` means freshly placed;
    /// lifetime is drawn on its first update. Ignition of flammables is a no-op (none exist yet).
    fn update_fire(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        fn ok(m: u8) -> bool {
            m == EMPTY
        }
        let i = y * self.w + x;
        // Water + Fire -> Water; the fire is removed (steam does not exist yet, D-018).
        for (dx, dy) in [(0, -1), (0, 1), (-1, 0), (1, 0)] {
            if let Some((nx, ny)) = self.off(x, y, dx, dy) {
                if self.at(nx, ny) == WATER {
                    self.set(i, EMPTY, 0);
                    return;
                }
            }
        }
        let a = self.aux[i];
        if a == 0 {
            let life = 30 + rng(seed, tick, x as u32, y as u32, SALT_FIRE_LIFE) % 61;
            self.set(i, FIRE, life as u8);
            return;
        }
        if a == 1 {
            self.set(i, EMPTY, 0);
            return;
        }
        self.aux[i] = a - 1;
        self.touch(i);
        let r = rng(seed, tick, x as u32, y as u32, SALT_FIRE_RISE);
        if r % 4 != 0 {
            self.try_move(x, y, 0, -1, ok);
        } else {
            let d = if rng(seed, tick, x as u32, y as u32, SALT_FIRE_DIR) & 1 == 0 { -1 } else { 1 };
            if !self.try_move(x, y, d, -1, ok) {
                self.try_move(x, y, d, 0, ok);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sand_falls() {
        let mut g = Grid::new(64, 64);
        g.set(10 * 64 + 5, SAND, 0);
        for t in 0..10 {
            g.step_cells(1, t);
        }
        assert_eq!(g.at(5, 20), SAND);
        assert_eq!(g.at(5, 10), EMPTY);
    }

    #[test]
    fn sand_sinks_through_water() {
        let mut g = Grid::new(64, 64);
        g.set(63 * 64 + 5, BEDROCK, 0);
        g.set(62 * 64 + 5, WATER, 0);
        g.set(60 * 64 + 5, SAND, 0);
        for t in 0..20 {
            g.step_cells(1, t);
        }
        assert_eq!(g.at(5, 62), SAND);
    }

    #[test]
    fn water_spreads() {
        let mut g = Grid::new(64, 64);
        for x in 0..64 {
            g.set(63 * 64 + x, BEDROCK, 0);
        }
        for y in 40..50 {
            g.set(y * 64 + 32, WATER, 0);
        }
        for t in 0..200 {
            g.step_cells(7, t);
        }
        let on_floor = (0..64).filter(|&x| g.at(x, 62) == WATER).count();
        assert!(on_floor >= 8, "water only covers {on_floor} floor cells");
        assert_eq!((0..64 * 64).filter(|&i| g.mat[i] == WATER).count(), 10);
    }

    #[test]
    fn fire_rises_and_dies() {
        let mut g = Grid::new(64, 64);
        g.set(50 * 64 + 5, FIRE, 0);
        for t in 0..150 {
            g.step_cells(3, t);
        }
        assert!(g.mat.iter().all(|&m| m == EMPTY));
    }

    #[test]
    fn water_extinguishes_fire() {
        let mut g = Grid::new(64, 64);
        g.set(10 * 64 + 5, FIRE, 0);
        g.set(10 * 64 + 6, BEDROCK, 0);
        g.set(11 * 64 + 5, BEDROCK, 0);
        g.set(9 * 64 + 5, BEDROCK, 0);
        g.set(10 * 64 + 4, WATER, 0);
        g.step_cells(3, 0);
        assert_eq!(g.at(5, 10), EMPTY);
    }
}

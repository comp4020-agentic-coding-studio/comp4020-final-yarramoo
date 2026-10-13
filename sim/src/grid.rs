//! World grid, chunk metadata and the cell update (plan 6.1, 6.2, 6.4).
#![allow(clippy::manual_is_multiple_of)]

use crate::materials::*;
use crate::rng::*;

pub const CHUNK: usize = 64;
pub const CHUNK_AREA: usize = CHUNK * CHUNK;
/// Active rectangle around a player (plan 6.5): the 480 x 270 view plus margin.
pub const ACTIVE_W: i32 = crate::tuning::ACTIVE_W;
pub const ACTIVE_H: i32 = crate::tuning::ACTIVE_H;

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
    /// Sleeping on/off (D7 test hook; on for real play). Invisible by design: see `step_cells`.
    pub sleep_enabled: bool,
    /// Scratch, not state: false means the chunk was quiet and has no volatile material, so it is
    /// skipped. Every touched cell sets its own chunk and any neighbour within 1 cell of the shared
    /// edge. Cleared just before a chunk runs, so a quiet run lets it sleep.
    pub awake: Vec<bool>,
    /// Scratch, not state: the semantic active set (plan 6.5). Inactive chunks are frozen.
    pub active: Vec<bool>,
    /// Scratch: set by `update_cell` when it sees a volatile material in the chunk being run.
    vol_seen: bool,
    /// Telemetry only: chunks actually run in the last `step_cells`.
    pub ran_chunks: u32,
    /// Scratch, not state: explosions queued during this tick's cell pass (plan 6.2 step 4).
    /// Primed Gunpowder lives in the grid (`aux == 1`), so leftovers beyond the cap are not lost.
    pending: Vec<(u32, u32)>,
}

/// Explosions resolved per tick. Bounds the per-tick cost of a chain (D-022).
pub const MAX_EXPLOSIONS_PER_TICK: usize = 256;
pub const BLAST_RADIUS: i32 = 4;

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
            sleep_enabled: true,
            awake: vec![true; cw * ch],
            active: vec![true; cw * ch],
            vol_seen: false,
            ran_chunks: 0,
            pending: Vec::new(),
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
        let (x, y) = (i % self.w, i / self.w);
        let c = self.chunk_of(x, y);
        self.dirty_since_hash[c] = true;
        self.pristine[c] = false;
        self.awake[c] = true;
        // Wake the neighbours whose cells can see this one (distance 1, corners included).
        let (lx, ly) = (x % CHUNK, y % CHUNK);
        let (cx, cy) = (c % self.cw, c / self.cw);
        let xs = [(lx == 0 && cx > 0, -1isize), (lx == CHUNK - 1 && cx + 1 < self.cw, 1)];
        let ys = [(ly == 0 && cy > 0, -1isize), (ly == CHUNK - 1 && cy + 1 < self.ch, 1)];
        for &(okx, dx) in &xs {
            if okx {
                self.awake[(c as isize + dx) as usize] = true;
            }
        }
        for &(oky, dy) in &ys {
            if !oky {
                continue;
            }
            let row = (c as isize + dy * self.cw as isize) as usize;
            self.awake[row] = true;
            for &(okx, dx) in &xs {
                if okx {
                    self.awake[(row as isize + dx) as usize] = true;
                }
            }
        }
    }

    pub fn mark_chunk(&mut self, c: usize) {
        self.dirty_since_hash[c] = true;
        self.pristine[c] = false;
        self.awake[c] = true;
    }

    /// Wake every chunk (after the sleep switch is turned on, or a restore).
    pub fn wake_all(&mut self) {
        self.awake.fill(true);
    }

    /// Set the active set from the centres (cell coordinates) of active players: a chunk is active
    /// if it intersects the 576 x 320 rectangle around any centre. An empty list means nothing is
    /// active; callers decide what an empty player list means for their world kind.
    pub fn set_active_around(&mut self, centres: &[(i32, i32)]) {
        let (hw, hh) = (ACTIVE_W / 2, ACTIVE_H / 2);
        for c in 0..self.chunk_count() {
            let (x0, y0) = ((c % self.cw * CHUNK) as i32, (c / self.cw * CHUNK) as i32);
            let (x1, y1) = (x0 + CHUNK as i32, y0 + CHUNK as i32);
            self.active[c] = centres.iter().any(|&(px, py)| x0 < px + hw && x1 > px - hw && y0 < py + hh && y1 > py - hh);
        }
    }

    pub fn set_all_active(&mut self) {
        self.active.fill(true);
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
        self.pending.clear();
        let odd = tick & 1 == 1;
        self.ran_chunks = 0;
        for cy in (0..self.ch).rev() {
            for ci in 0..self.cw {
                let cx = if odd { self.cw - 1 - ci } else { ci };
                let c = cy * self.cw + cx;
                if !self.active[c] {
                    // Frozen, but awake so it runs on its first active tick.
                    self.awake[c] = true;
                    continue;
                }
                if self.sleep_enabled {
                    if !self.awake[c] {
                        continue;
                    }
                    // Quiet unless this run changes a cell here or meets a volatile material.
                    self.awake[c] = false;
                    self.vol_seen = false;
                }
                self.ran_chunks += 1;
                for y in (cy * CHUNK..cy * CHUNK + CHUNK).rev() {
                    for xi in 0..CHUNK {
                        let x = cx * CHUNK + if odd { CHUNK - 1 - xi } else { xi };
                        self.update_cell(x, y, seed, tick);
                    }
                }
                if self.vol_seen {
                    self.awake[c] = true;
                }
            }
        }
        self.resolve_explosions(seed, tick);
    }

    fn update_cell(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        let i = y * self.w + x;
        if self.moved[i] != 0 {
            // Changed this tick by something that ran earlier, and skipped here: look again next tick.
            self.vol_seen = true;
            return;
        }
        let m = self.mat[i];
        // Volatile: acts on chance, a timer or a counter even when nothing around it changes, so the
        // chunk may not sleep (plan 6.4). Lava also ignites neighbours by chance. A resting powder or
        // liquid is not volatile: with an unchanged neighbourhood it provably does nothing.
        if matches!(m, FIRE | SMOKE | STEAM | SEED | LAVA)
            || (m == STEM && self.aux[i] != 0)
            || (m == GUNPOWDER && self.aux[i] == 1)
        {
            self.vol_seen = true;
        }
        match m {
            SAND => {
                self.powder_move(x, y, seed, tick, SALT_SAND_DIAG);
            }
            WATER => self.update_water(x, y, seed, tick),
            FIRE => self.update_fire(x, y, seed, tick),
            SMOKE => self.update_gas(x, y, seed, tick, SMOKE),
            STEAM => self.update_gas(x, y, seed, tick, STEAM),
            SEED => self.update_seed(x, y, seed, tick),
            STEM => self.update_stem(x, y, seed, tick),
            GUNPOWDER => self.update_gunpowder(x, y, seed, tick),
            LAVA => self.update_lava(x, y, seed, tick),
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

    /// First von Neumann neighbour (up, down, left, right) satisfying `pred`.
    fn find_neighbour(&self, x: usize, y: usize, pred: fn(u8) -> bool) -> Option<(usize, usize)> {
        for (dx, dy) in [(0, -1), (0, 1), (-1, 0), (1, 0)] {
            if let Some((nx, ny)) = self.off(x, y, dx, dy) {
                if pred(self.at(nx, ny)) {
                    return Some((nx, ny));
                }
            }
        }
        None
    }

    /// Powders (Sand, Seed, Gunpowder) are densest: they sink through gas, Water and Lava.
    fn powder_ok(m: u8) -> bool {
        m == EMPTY || (is_gas(m) && m != FIRE) || m == WATER || m == LAVA
    }

    /// Liquids displace Empty and the light gases (not Fire).
    fn liquid_ok(m: u8) -> bool {
        m == EMPTY || m == SMOKE || m == STEAM
    }

    /// Returns true if the powder moved.
    fn powder_move(&mut self, x: usize, y: usize, seed: u64, tick: u32, salt: u32) -> bool {
        if self.try_move(x, y, 0, 1, Self::powder_ok) {
            return true;
        }
        let d = if rng(seed, tick, x as u32, y as u32, salt) & 1 == 0 { -1 } else { 1 };
        self.try_move(x, y, d, 1, Self::powder_ok) || self.try_move(x, y, -d, 1, Self::powder_ok)
    }

    /// Shared liquid motion: down, diagonal down, sideways.
    fn liquid_move(&mut self, x: usize, y: usize, seed: u64, tick: u32, diag: u32, side: u32) {
        let ok = Self::liquid_ok;
        if self.try_move(x, y, 0, 1, ok) {
            return;
        }
        let d = if rng(seed, tick, x as u32, y as u32, diag) & 1 == 0 { -1 } else { 1 };
        if self.try_move(x, y, d, 1, ok) || self.try_move(x, y, -d, 1, ok) {
            return;
        }
        let s = if rng(seed, tick, x as u32, y as u32, side) & 1 == 0 { -1 } else { 1 };
        if self.try_move(x, y, s, 0, ok) {
            return;
        }
        self.try_move(x, y, -s, 0, ok);
    }

    fn update_water(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        self.liquid_move(x, y, seed, tick, SALT_WATER_DIAG, SALT_WATER_SIDE);
    }

    /// Lava: touching Water turns the lava to Rock and the water to Steam; ignites flammables;
    /// moves only on even ticks (slow).
    fn update_lava(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        let i = y * self.w + x;
        if let Some((nx, ny)) = self.find_neighbour(x, y, |m| m == WATER) {
            self.set(i, ROCK, 0);
            self.set(ny * self.w + nx, STEAM, 0);
            return;
        }
        for (dx, dy) in [(0, -1), (0, 1), (-1, 0), (1, 0)] {
            if let Some((nx, ny)) = self.off(x, y, dx, dy) {
                if is_flammable(self.at(nx, ny))
                    && rng(seed, tick, nx as u32, ny as u32, SALT_LAVA_IGNITE) % 8 == 0
                {
                    self.set(ny * self.w + nx, FIRE, 0);
                }
            }
        }
        if tick & 1 == 0 {
            self.liquid_move(x, y, seed, tick, SALT_LAVA_DIAG, SALT_LAVA_SIDE);
        }
    }

    /// Fire: `aux` holds remaining lifetime (30..=90). `aux == 0` means freshly placed;
    /// lifetime is drawn on its first update.
    fn update_fire(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        fn ok(m: u8) -> bool {
            m == EMPTY
        }
        let i = y * self.w + x;
        // Water + Fire -> Steam; the fire cell becomes the steam, the water stays.
        if self.find_neighbour(x, y, |m| m == WATER).is_some() {
            self.set(i, STEAM, 0);
            return;
        }
        // Ignite adjacent flammables by chance: Wood burns slowly, plants quickly.
        for (dx, dy) in [(0, -1), (0, 1), (-1, 0), (1, 0)] {
            if let Some((nx, ny)) = self.off(x, y, dx, dy) {
                let m = self.at(nx, ny);
                if is_flammable(m) {
                    let n = if m == WOOD { 12 } else { 4 };
                    if rng(seed, tick, nx as u32, ny as u32, SALT_FIRE_IGNITE) % n == 0 {
                        self.set(ny * self.w + nx, FIRE, 0);
                    }
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
            let smoky = rng(seed, tick, x as u32, y as u32, SALT_FIRE_SMOKE) % 3 == 0;
            self.set(i, if smoky { SMOKE } else { EMPTY }, 0);
            return;
        }
        self.aux[i] = a - 1;
        self.touch(i);
        // Fire touching fuel lingers on it instead of drifting off, so it can spread.
        if self.find_neighbour(x, y, is_flammable).is_some() {
            return;
        }
        let r = rng(seed, tick, x as u32, y as u32, SALT_FIRE_RISE);
        if r & 3 != 0 {
            self.try_move(x, y, 0, -1, ok);
        } else {
            let d = if rng(seed, tick, x as u32, y as u32, SALT_FIRE_DIR) & 1 == 0 { -1 } else { 1 };
            if !self.try_move(x, y, d, -1, ok) {
                self.try_move(x, y, d, 0, ok);
            }
        }
    }

    /// Smoke and Steam: `aux` is remaining lifetime (0 = draw it now), rise into Empty, then vanish.
    fn update_gas(&mut self, x: usize, y: usize, seed: u64, tick: u32, kind: u8) {
        fn ok(m: u8) -> bool {
            m == EMPTY
        }
        let (life_salt, rise_salt, dir_salt, base, span) = if kind == SMOKE {
            (SALT_SMOKE_LIFE, SALT_SMOKE_RISE, SALT_SMOKE_DIR, 40, 81)
        } else {
            (SALT_STEAM_LIFE, SALT_STEAM_RISE, SALT_STEAM_DIR, 60, 121)
        };
        let i = y * self.w + x;
        let a = self.aux[i];
        if a == 0 {
            let life = base + rng(seed, tick, x as u32, y as u32, life_salt) % span;
            self.set(i, kind, life as u8);
            return;
        }
        if a == 1 {
            self.set(i, EMPTY, 0);
            return;
        }
        self.aux[i] = a - 1;
        self.touch(i);
        if rng(seed, tick, x as u32, y as u32, rise_salt) & 3 != 0 && self.try_move(x, y, 0, -1, ok)
        {
            return;
        }
        let d = if rng(seed, tick, x as u32, y as u32, dir_salt) & 1 == 0 { -1 } else { 1 };
        if !self.try_move(x, y, d, -1, ok) {
            self.try_move(x, y, d, 0, ok);
        }
    }

    /// Seed: falls like a powder. Resting on Dirt, `aux` counts up (faster with Water within 2
    /// cells) and at `GERMINATE_AT` becomes a Stem with a target height of 8..=14.
    fn update_seed(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        if self.powder_move(x, y, seed, tick, SALT_SEED_DIAG) {
            return;
        }
        let i = y * self.w + x;
        let on_dirt = matches!(self.off(x, y, 0, 1), Some((bx, by)) if self.at(bx, by) == DIRT);
        if !on_dirt {
            return;
        }
        let wet = (y.saturating_sub(2)..=(y + 2).min(self.h - 1)).any(|yy| {
            (x.saturating_sub(2)..=(x + 2).min(self.w - 1)).any(|xx| self.at(xx, yy) == WATER)
        });
        let r = rng(seed, tick, x as u32, y as u32, SALT_SEED_GERM);
        let grows = if wet { r % 2 == 0 } else { r % 6 == 0 };
        if !grows {
            return;
        }
        let a = self.aux[i] + 1;
        if a < GERMINATE_AT {
            self.aux[i] = a;
            self.touch(i);
        } else {
            let target = 8 + rng(seed, tick, x as u32, y as u32, SALT_SEED_HEIGHT) % 7;
            // aux = target << 4 | current height. Only the growing tip has a non-zero aux.
            self.set(i, STEM, ((target << 4) | 1) as u8);
        }
    }

    /// Stem: the tip (aux != 0) extends upward at random until it reaches its target height,
    /// then places a Flower and matures (aux = 0). Blocked tips mature without a Flower.
    fn update_stem(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        let i = y * self.w + x;
        let a = self.aux[i] as u32;
        if a == 0 {
            return;
        }
        if rng(seed, tick, x as u32, y as u32, SALT_STEM_GROW) % 12 != 0 {
            return;
        }
        let (target, cur) = (a >> 4, a & 15);
        let above = self.off(x, y, 0, -1).filter(|&(ax, ay)| self.at(ax, ay) == EMPTY);
        match above {
            Some((ax, ay)) => {
                let j = ay * self.w + ax;
                if cur >= target {
                    self.set(j, FLOWER, 0);
                } else {
                    self.set(j, STEM, ((target << 4) | (cur + 1)) as u8);
                }
                self.moved[j] = 1;
                self.set(i, STEM, 0);
            }
            None => self.set(i, STEM, 0),
        }
    }

    /// Gunpowder: a powder. Touching Fire or Lava primes it (`aux = 1`); a primed cell is queued to
    /// explode on its next update, so chains advance one link per tick.
    fn update_gunpowder(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        let i = y * self.w + x;
        if self.aux[i] == 1 {
            if self.pending.len() < MAX_EXPLOSIONS_PER_TICK {
                self.pending.push((x as u32, y as u32));
            }
            return;
        }
        if self.find_neighbour(x, y, |m| m == FIRE || m == LAVA).is_some() {
            self.set(i, GUNPOWDER, 1);
            self.moved[i] = 1;
            return;
        }
        self.powder_move(x, y, seed, tick, SALT_GUNPOWDER_DIAG);
    }

    /// Plan 6.2 step 4: resolve this tick's queued explosions in queue order.
    fn resolve_explosions(&mut self, seed: u64, tick: u32) {
        let queue = core::mem::take(&mut self.pending);
        let r = BLAST_RADIUS;
        for &(cx, cy) in &queue {
            let (cx, cy) = (cx as i32, cy as i32);
            let ci = cy as usize * self.w + cx as usize;
            if self.mat[ci] != GUNPOWDER {
                continue;
            }
            for y in (cy - r).max(0)..=(cy + r).min(self.h as i32 - 1) {
                for x in (cx - r).max(0)..=(cx + r).min(self.w as i32 - 1) {
                    let d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
                    if d2 > r * r {
                        continue;
                    }
                    let i = y as usize * self.w + x as usize;
                    match self.mat[i] {
                        BEDROCK => {}
                        // Caught in the blast: primed, explodes on the next tick.
                        GUNPOWDER if i != ci => {
                            if self.aux[i] != 1 {
                                self.set(i, GUNPOWDER, 1);
                            }
                        }
                        _ => {
                            let rim = d2 > (r - 1) * (r - 1)
                                && rng(seed, tick, x as u32, y as u32, SALT_BLAST_RIM) % 3 == 0;
                            self.set(i, if rim { FIRE } else { EMPTY }, 0);
                        }
                    }
                }
            }
        }
    }
}

const GERMINATE_AT: u8 = 60;

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
        for x in 0..64 {
            g.set(63 * 64 + x, BEDROCK, 0);
        }
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

    fn boxed(w: usize, h: usize) -> Grid {
        let mut g = Grid::new(w, h);
        for x in 0..w {
            g.set((h - 1) * w + x, BEDROCK, 0);
        }
        g
    }

    fn run(g: &mut Grid, seed: u64, ticks: u32) {
        for t in 0..ticks {
            g.step_cells(seed, t);
        }
    }

    fn count(g: &Grid, m: u8) -> usize {
        g.mat.iter().filter(|&&c| c == m).count()
    }

    #[test]
    fn water_fire_makes_steam() {
        let mut g = Grid::new(64, 64);
        for (x, y) in [(4, 9), (5, 9), (6, 9), (4, 10), (6, 10), (4, 11), (5, 11), (6, 11)] {
            g.set(y * 64 + x, BEDROCK, 0);
        }
        g.set(10 * 64 + 5, FIRE, 0);
        g.set(9 * 64 + 5, BEDROCK, 0);
        g.set(11 * 64 + 5, WATER, 0);
        for x in 4..=6 {
            g.set(12 * 64 + x, BEDROCK, 0);
        }
        g.step_cells(3, 0);
        assert_eq!(g.at(5, 10), STEAM);
        assert_eq!(g.at(5, 11), WATER);
    }

    #[test]
    fn steam_and_smoke_rise_then_vanish() {
        for m in [STEAM, SMOKE] {
            let mut g = Grid::new(64, 64);
            g.set(50 * 64 + 5, m, 0);
            g.step_cells(3, 0);
            run(&mut g, 3, 5);
            assert!((0..64).any(|y| (0..64).any(|x| g.at(x, y) == m && y < 50)));
            run(&mut g, 3, 400);
            assert_eq!(count(&g, m), 0);
        }
    }

    #[test]
    fn fire_burns_wood() {
        let mut g = boxed(64, 64);
        for y in 40..60 {
            g.set(y * 64 + 30, WOOD, 0);
        }
        g.set(59 * 64 + 31, FIRE, 0);
        run(&mut g, 5, 1500);
        assert_eq!(count(&g, WOOD), 0, "wood should burn away");
        assert_eq!(count(&g, FIRE), 0);
    }

    #[test]
    fn fire_can_leave_smoke() {
        let mut g = Grid::new(64, 64);
        let mut saw = false;
        for k in 0..30 {
            g.set((50 - k % 5) * 64 + 5 + k, FIRE, 0);
        }
        for t in 0..120 {
            g.step_cells(9, t);
            saw |= count(&g, SMOKE) > 0;
        }
        assert!(saw);
    }

    #[test]
    fn lava_and_water_make_rock_and_steam() {
        let mut g = boxed(64, 64);
        g.set(60 * 64 + 10, LAVA, 0);
        g.set(60 * 64 + 11, WATER, 0);
        g.step_cells(2, 0);
        assert_eq!(g.at(10, 60), ROCK);
        assert_eq!(g.at(11, 60), STEAM);
    }

    #[test]
    fn lava_moves_every_other_tick_and_ignites_wood() {
        let mut g = Grid::new(64, 64);
        g.set(10 * 64 + 5, LAVA, 0);
        g.step_cells(1, 0);
        assert_eq!(g.at(5, 11), LAVA);
        g.step_cells(1, 1);
        assert_eq!(g.at(5, 11), LAVA, "lava rests on odd ticks");
        let mut g = boxed(64, 64);
        g.set(62 * 64 + 5, LAVA, 0);
        for x in 3..8 {
            g.set(61 * 64 + x, WOOD, 0);
        }
        run(&mut g, 4, 300);
        assert!(count(&g, WOOD) < 5);
    }

    #[test]
    fn density_order() {
        // Sand sinks through lava.
        let mut g = boxed(64, 64);
        g.set(62 * 64 + 5, LAVA, 0);
        g.set(60 * 64 + 5, SAND, 0);
        run(&mut g, 1, 10);
        assert_eq!(g.at(5, 62), SAND);
        assert_eq!(count(&g, LAVA), 1);
    }

    #[test]
    fn seed_grows_stem_and_flower_on_dirt_with_water() {
        let mut g = boxed(64, 64);
        for x in 0..64 {
            g.set(62 * 64 + x, DIRT, 0);
        }
        g.set(61 * 64 + 20, SEED, 0);
        g.set(61 * 64 + 22, WATER, 0);
        run(&mut g, 11, 3000);
        assert_eq!(g.at(20, 61), STEM);
        let stems = (0..62).filter(|&y| g.at(20, y) == STEM).count();
        assert!((8..=14).contains(&stems), "stem length {stems}");
        let top = (0..62).find(|&y| g.at(20, y) != EMPTY).unwrap();
        assert_eq!(g.at(20, top), FLOWER);
    }

    #[test]
    fn seed_without_dirt_does_not_germinate() {
        let mut g = boxed(64, 64);
        g.set(62 * 64 + 20, SEED, 0);
        run(&mut g, 11, 1500);
        assert_eq!(g.at(20, 62), SEED);
    }

    #[test]
    fn flower_burns() {
        let mut g = boxed(64, 64);
        g.set(62 * 64 + 5, FLOWER, 0);
        g.set(62 * 64 + 6, FIRE, 0);
        run(&mut g, 2, 300);
        assert_eq!(count(&g, FLOWER), 0);
    }

    #[test]
    fn gunpowder_explodes_and_carves_but_spares_bedrock() {
        let mut g = Grid::new(64, 64);
        for y in 30..50 {
            for x in 20..40 {
                g.set(y * 64 + x, DIRT, 0);
            }
        }
        g.set(40 * 64 + 30, GUNPOWDER, 0);
        g.set(40 * 64 + 31, FIRE, 0);
        g.set(40 * 64 + 28, BEDROCK, 0);
        g.set(36 * 64 + 30, ROCK, 0);
        run(&mut g, 1, 4);
        assert_eq!(g.at(30, 40), EMPTY);
        assert_eq!(g.at(30, 37), EMPTY);
        assert_eq!(g.at(28, 40), BEDROCK);
        assert!(matches!(g.at(30, 36), EMPTY | FIRE), "rock destroyed by blast");
        assert_eq!(g.at(30, 44), EMPTY);
        assert_eq!(g.at(30, 46), DIRT, "outside the radius");
    }

    #[test]
    fn gunpowder_chain_spreads_over_ticks() {
        let mut g = boxed(256, 64);
        for x in 10..210 {
            g.set(62 * 256 + x, GUNPOWDER, 0);
        }
        g.set(62 * 256 + 10, GUNPOWDER, 1);
        let mut last = 200;
        let mut ticks_with_blast = 0;
        for t in 0..200 {
            g.step_cells(8, t);
            let n = count(&g, GUNPOWDER);
            if n < last {
                ticks_with_blast += 1;
            }
            last = n;
        }
        assert_eq!(count(&g, GUNPOWDER), 0, "whole line detonates");
        assert!(ticks_with_blast >= 10, "chain only took {ticks_with_blast} ticks");
    }

    #[test]
    fn explosion_cap_carries_over() {
        let mut g = Grid::new(128, 128);
        // A solid block of primed gunpowder: more cells than the per-tick cap.
        for y in 10..40 {
            for x in 10..40 {
                g.set(y * 128 + x, GUNPOWDER, 1);
            }
        }
        g.step_cells(1, 0);
        assert!(g.pending.is_empty());
        // Cap bounded the work, yet everything eventually goes.
        run(&mut g, 1, 60);
        assert_eq!(count(&g, GUNPOWDER), 0);
    }

    #[test]
    fn new_materials_are_paintable_but_not_bedrock() {
        for m in (0u8..=14).filter(|&m| m != BEDROCK) {
            assert!(paintable(m), "{m}");
        }
        assert!(!paintable(BEDROCK) && !paintable(15));
    }
}

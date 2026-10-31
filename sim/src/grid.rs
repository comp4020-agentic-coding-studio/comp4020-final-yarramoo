//! World grid, chunk metadata and the cell update (plan 6.1, 6.2, 6.4).
#![allow(clippy::manual_is_multiple_of)]

use crate::materials::*;
use crate::rng::*;
use crate::tuning::{DIG_RADIUS, DIG_REACH};

pub const CHUNK: usize = 64;
/// How a liquid moves: its randomness salts and how far it can slide sideways in one update.
#[derive(Clone, Copy)]
pub struct Liquid {
    diag: u32,
    side: u32,
    reach: usize,
    /// What this liquid may displace (Empty, light gases, and any lighter liquid: density order).
    ok: fn(u8) -> bool,
}
/// Acid sinks through Oil and is sunk through by Water (Oil < Acid < Water).
const ACID_FLOW: Liquid = Liquid { diag: SALT_ACID_DIAG, side: SALT_ACID_SIDE, reach: 4, ok: Grid::acid_ok };
const WATER_FLOW: Liquid = Liquid { diag: SALT_WATER_DIAG, side: SALT_WATER_SIDE, reach: 6, ok: Grid::water_ok };
/// Oil floats on Water: it only displaces what is lighter than it.
const OIL_FLOW: Liquid = Liquid { diag: SALT_OIL_DIAG, side: SALT_OIL_SIDE, reach: 5, ok: Grid::liquid_ok };
/// Lava is thicker, so it spreads less per update (and it only moves on even ticks).
const LAVA_FLOW: Liquid = Liquid { diag: SALT_LAVA_DIAG, side: SALT_LAVA_SIDE, reach: 3, ok: Grid::liquid_ok };
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
    /// Scratch, not state, like `awake` (D-054): the centres that really detonated in the last
    /// `step_cells`, in queue order, for the damage pass. Cleared at the start of each `step_cells`,
    /// never hashed or snapshotted, and never fed back into the grid.
    pub explosions: Vec<(u32, u32)>,
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
            explosions: Vec::new(),
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
        self.explosions.clear();
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
        if matches!(m, FIRE | SMOKE | STEAM | SEED | LAVA | ACID)
            || (m == STEM && self.aux[i] != 0)
            || (m == GUNPOWDER && self.aux[i] == 1)
            || (m == COAL && self.aux[i] != 0)
        {
            self.vol_seen = true;
        }
        match m {
            SAND => {
                self.powder_move(x, y, seed, tick, SALT_SAND_DIAG);
            }
            WATER => self.update_water(x, y, seed, tick),
            OIL => self.liquid_move(x, y, seed, tick, OIL_FLOW),
            ACID => self.update_acid(x, y, seed, tick),
            GAS => self.update_marsh_gas(x, y, seed, tick),
            ICE => self.update_ice(x, y, seed, tick),
            COAL => self.update_coal(x, y, seed, tick),
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
        m == EMPTY || m == SMOKE || m == STEAM || m == GAS
    }

    /// Water also sinks through Oil (density order: Oil < Water).
    fn water_ok(m: u8) -> bool {
        Self::liquid_ok(m) || m == OIL || m == ACID
    }

    fn acid_ok(m: u8) -> bool {
        Self::liquid_ok(m) || m == OIL
    }

    /// Returns true if the powder moved.
    fn powder_move(&mut self, x: usize, y: usize, seed: u64, tick: u32, salt: u32) -> bool {
        if self.try_move(x, y, 0, 1, Self::powder_ok) {
            return true;
        }
        let d = if rng(seed, tick, x as u32, y as u32, salt) & 1 == 0 { -1 } else { 1 };
        self.try_move(x, y, d, 1, Self::powder_ok) || self.try_move(x, y, -d, 1, Self::powder_ok)
    }

    /// Shared liquid motion: down, diagonal down, then a sideways slide of up to `reach` cells.
    fn liquid_move(&mut self, x: usize, y: usize, seed: u64, tick: u32, l: Liquid) {
        let ok = l.ok;
        if self.try_move(x, y, 0, 1, ok) {
            return;
        }
        // The rng only picks which side is tried first, so it is drawn only when both sides are open
        // (a lone open side is taken whatever the draw says; none open moves nothing). Same result.
        let open = |g: &Grid, dx: isize, dy: isize| g.off(x, y, dx, dy).is_some_and(|(nx, ny)| ok(g.at(nx, ny)));
        let (dl, dr) = (open(self, -1, 1), open(self, 1, 1));
        if dl || dr {
            let d = if dl && dr {
                if rng(seed, tick, x as u32, y as u32, l.diag) & 1 == 0 { -1 } else { 1 }
            } else if dl {
                -1
            } else {
                1
            };
            if self.try_move(x, y, d, 1, ok) || self.try_move(x, y, -d, 1, ok) {
                return;
            }
        }
        let (sl, sr) = (open(self, -1, 0), open(self, 1, 0));
        if !sl && !sr {
            return;
        }
        let s = if sl && sr {
            if rng(seed, tick, x as u32, y as u32, l.side) & 1 == 0 { -1 } else { 1 }
        } else if sl {
            -1
        } else {
            1
        };
        if !self.slide(x, y, s, l.reach, ok) {
            self.slide(x, y, -s, l.reach, ok);
        }
    }

    /// Slide a liquid cell sideways to the furthest free cell within `reach`, stopping at the first
    /// blocked one, and dropping into a gap it passes over. One step at a time, a deep heap only levels
    /// from its surface a cell per update and settles into a staircase on chunk edges; dispersion is how
    /// a liquid finds its level. Bounded by `reach`, integer-only, and a fixed scan order.
    fn slide(&mut self, x: usize, y: usize, dir: isize, reach: usize, ok: fn(u8) -> bool) -> bool {
        let mut best = None;
        for k in 1..=reach as isize {
            let Some((nx, ny)) = self.off(x, y, dir * k, 0) else { break };
            if !ok(self.at(nx, ny)) {
                break;
            }
            best = Some((nx, ny));
            if self.off(nx, ny, 0, 1).is_some_and(|(bx, by)| ok(self.at(bx, by))) {
                break; // a gap below: fall into it from here
            }
        }
        match best {
            Some((nx, ny)) => {
                self.swap(y * self.w + x, ny * self.w + nx);
                true
            }
            None => false,
        }
    }

    fn update_water(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        self.liquid_move(x, y, seed, tick, WATER_FLOW);
    }

    /// Acid: `aux` is its strength (0 = fresh, becomes `ACID_STRENGTH`). Each tick at most one thing happens:
    /// dilute against a Water neighbour (both become Water, 1 in 6), or dissolve one dissolvable neighbour
    /// (1 in 4), using one point of strength (the cell vanishes at 1). Bedrock and Glass are immune. Otherwise
    /// it flows. Work: four neighbour reads, one move.
    fn update_acid(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        let i = y * self.w + x;
        if self.aux[i] == 0 {
            self.set(i, ACID, ACID_STRENGTH);
            return;
        }
        for (dx, dy) in [(0, -1), (0, 1), (-1, 0), (1, 0)] {
            let Some((nx, ny)) = self.off(x, y, dx, dy) else { continue };
            let n = ny * self.w + nx;
            let m = self.mat[n];
            if m == WATER {
                if rng(seed, tick, x as u32, y as u32, SALT_ACID_DILUTE) % 6 == 0 {
                    self.set(i, WATER, 0);
                    return;
                }
            } else if Self::dissolvable(m) && rng(seed, tick, nx as u32, ny as u32, SALT_ACID_EAT) % 4 == 0 {
                self.set(n, EMPTY, 0);
                let a = self.aux[i] - 1;
                if a <= 1 {
                    self.set(i, EMPTY, 0);
                } else {
                    self.aux[i] = a;
                    self.touch(i);
                }
                return;
            }
        }
        self.liquid_move(x, y, seed, tick, ACID_FLOW);
    }

    /// Marsh gas: rises like smoke but never expires, so it lingers in pockets. No chance is involved except
    /// which side to take when two are open (drawn only then), so a gas cell that cannot move provably does
    /// nothing and its chunk may sleep. Burning is done by the Fire cell next to it (see `update_fire`).
    fn update_marsh_gas(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        fn ok(m: u8) -> bool {
            m == EMPTY
        }
        if self.try_move(x, y, 0, -1, ok) {
            return;
        }
        let open = |g: &Grid, dx: isize, dy: isize| g.off(x, y, dx, dy).is_some_and(|(nx, ny)| ok(g.at(nx, ny)));
        for dy in [-1isize, 0] {
            let (l, r) = (open(self, -1, dy), open(self, 1, dy));
            if l || r {
                let d = if l && r {
                    if rng(seed, tick, x as u32, y as u32, SALT_MGAS_DIR) & 1 == 0 { -1 } else { 1 }
                } else if l {
                    -1
                } else {
                    1
                };
                self.try_move(x, y, d, dy, ok);
                return;
            }
        }
    }

    /// Ice: static. `aux` is its freezing budget plus one (0 = fresh, becomes `ICE_COLD + 1`; 1 = spent).
    /// A Water neighbour freezes (1 in 20) and spends one point; ice made this way is spent, so a lake
    /// cannot freeze through a chain. Melting is done by the Fire or Lava next to it (those cells are
    /// volatile and always run), so a sleeping chunk of ice is never what decides a melt. Only an ice cell
    /// with budget left and Water beside it is volatile: its roll is a chance that needs no change nearby.
    fn update_ice(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        let i = y * self.w + x;
        if self.aux[i] == 0 {
            self.set(i, ICE, ICE_COLD + 1);
            return;
        }
        if self.aux[i] <= 1 {
            return;
        }
        for (dx, dy) in [(0, -1), (0, 1), (-1, 0), (1, 0)] {
            let Some((nx, ny)) = self.off(x, y, dx, dy) else { continue };
            if self.at(nx, ny) == WATER {
                self.vol_seen = true;
                if rng(seed, tick, x as u32, y as u32, SALT_ICE_FREEZE) % 20 == 0 {
                    self.set(ny * self.w + nx, ICE, 1);
                    self.moved[ny * self.w + nx] = 1;
                    self.aux[i] -= 1;
                    return;
                }
            }
        }
    }

    /// Coal: a static solid (it does not fall). `aux` 0 is unlit; a lit cell counts `COAL_BURN` ticks down to
    /// nothing, glowing as Coal, and on the way sheds Fire into an empty neighbour (1 in 6, up first) and
    /// sometimes Smoke. It is lit by Fire or Lava next to it (`light_coal`). Four neighbour reads per tick.
    fn update_coal(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        let i = y * self.w + x;
        let a = self.aux[i];
        if a == 0 {
            return;
        }
        if a == 1 {
            self.set(i, EMPTY, 0);
            return;
        }
        self.aux[i] = a - 1;
        self.touch(i);
        // A lit cell passes the fire to a coal neighbour now and then (a seam burns along its length).
        for (dx, dy) in [(0, -1), (0, 1), (-1, 0), (1, 0)] {
            if let Some((nx, ny)) = self.off(x, y, dx, dy) {
                if self.at(nx, ny) == COAL && rng(seed, tick, nx as u32, ny as u32, SALT_COAL_IGNITE) % 24 == 0 {
                    self.light_coal(ny * self.w + nx);
                }
            }
        }
        let r = rng(seed, tick, x as u32, y as u32, SALT_COAL_EMIT);
        if r % 6 == 0 {
            for (dx, dy) in [(0, -1), (-1, 0), (1, 0), (0, 1)] {
                if let Some((nx, ny)) = self.off(x, y, dx, dy) {
                    if self.at(nx, ny) == EMPTY {
                        let smoky = rng(seed, tick, x as u32, y as u32, SALT_COAL_SMOKE) % 3 == 0;
                        self.set(ny * self.w + nx, if smoky { SMOKE } else { FIRE }, 0);
                        break;
                    }
                }
            }
        }
    }

    /// Light the Coal at flat index `n`, if it is unlit.
    fn light_coal(&mut self, n: usize) {
        if self.aux[n] == 0 {
            self.set(n, COAL, COAL_BURN);
        }
    }

    fn dissolvable(m: u8) -> bool {
        matches!(m, ROCK | DIRT | SAND | WOOD | SEED | STEM | FLOWER)
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
                let m = self.at(nx, ny);
                let n = ny * self.w + nx;
                if is_flammable(m) && rng(seed, tick, nx as u32, ny as u32, SALT_LAVA_IGNITE) % 8 == 0 {
                    self.set(n, FIRE, 0);
                } else if m == COAL && rng(seed, tick, nx as u32, ny as u32, SALT_COAL_IGNITE) % 16 == 0 {
                    self.light_coal(n);
                } else if m == ICE && rng(seed, tick, nx as u32, ny as u32, SALT_ICE_MELT) % 2 == 0 {
                    self.set(n, WATER, 0);
                } else if m == SAND && rng(seed, tick, nx as u32, ny as u32, SALT_LAVA_GLASS) % 10 == 0 {
                    self.set(n, GLASS, 0);
                }
            }
        }
        if tick & 1 == 0 {
            self.liquid_move(x, y, seed, tick, LAVA_FLOW);
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
                if m == COAL && rng(seed, tick, nx as u32, ny as u32, SALT_COAL_IGNITE) % 8 == 0 {
                    self.light_coal(ny * self.w + nx);
                }
                if m == ICE && rng(seed, tick, nx as u32, ny as u32, SALT_ICE_MELT) % 3 == 0 {
                    self.set(ny * self.w + nx, WATER, 0);
                }
                if is_flammable(m) {
                    let n = match m {
                        WOOD => 12,
                        OIL => 2,
                        GAS => 1,
                        _ => 4,
                    };
                    if rng(seed, tick, nx as u32, ny as u32, SALT_FIRE_IGNITE) % n == 0 {
                        // Gas flashes: a short-lived fire, so the front runs through the pocket.
                        self.set(ny * self.w + nx, FIRE, if m == GAS { FLASH_LIFE } else { 0 });
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
        if self.find_neighbour(x, y, |m| is_flammable(m) || m == COAL).is_some() {
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

    /// Stem tips (D-084). `aux` is `hi << 4 | lo`; only a growing tip has a non-zero aux.
    /// `hi` 8..=14 is a main tip (`hi` = target height, `lo` = current height), exactly D-024's
    /// encoding, so stems saved by the older rule keep growing. `hi` 1..=7 is a side-branch tip
    /// (`hi` = steps left, `lo` 1 = leans left, 2 = right). Any other non-zero value (never written)
    /// is clamped or finished, so no saved byte can grow without bound.
    fn update_stem(&mut self, x: usize, y: usize, seed: u64, tick: u32) {
        let i = y * self.w + x;
        let a = self.aux[i] as u32;
        if a == 0 {
            return;
        }
        if rng(seed, tick, x as u32, y as u32, SALT_STEM_GROW) % 12 != 0 {
            return;
        }
        let (hi, lo) = (a >> 4, a & 15);
        if hi == 0 {
            self.set(i, STEM, 0);
        } else if hi < 8 {
            self.grow_branch(x, y, hi, lo, seed, tick);
        } else {
            self.grow_main(x, y, hi.min(14), lo, seed, tick);
        }
    }

    fn empty_at(&self, x: usize, y: usize, dx: isize, dy: isize) -> Option<(usize, usize)> {
        self.off(x, y, dx, dy).filter(|&(ax, ay)| self.at(ax, ay) == EMPTY)
    }

    /// Put a new cell and mark it as already moved this tick, so it does not act until the next.
    fn put_plant(&mut self, p: (usize, usize), m: u8, aux: u8) {
        let j = p.1 * self.w + p.0;
        self.set(j, m, aux);
        self.moved[j] = 1;
    }

    /// Flower shapes, chosen by rng at the moment of blooming: one cell, a T (cell with both sides
    /// and the top), or a 2x2 cluster leaning right. Only Empty cells are filled.
    fn bloom(&mut self, p: (usize, usize), seed: u64, tick: u32) {
        let shape = rng(seed, tick, p.0 as u32, p.1 as u32, SALT_STEM_BLOOM) % 4;
        self.put_plant(p, FLOWER, 0);
        let extra: &[(isize, isize)] = match shape {
            2 => &[(-1, 0), (1, 0), (0, -1)],
            3 => &[(1, 0), (0, -1), (1, -1)],
            _ => &[],
        };
        for &(dx, dy) in extra {
            if let Some(q) = self.empty_at(p.0, p.1, dx, dy) {
                self.put_plant(q, FLOWER, 0);
            }
        }
    }

    fn grow_main(&mut self, x: usize, y: usize, target: u32, cur: u32, seed: u64, tick: u32) {
        let (xu, yu) = (x as u32, y as u32);
        let i = y * self.w + x;
        let r = rng(seed, tick, xu, yu, SALT_STEM_LEAN);
        // Lean: one step in four goes diagonally, falling back to straight up if that is blocked.
        let dx: isize = match r % 8 {
            0 => -1,
            1 => 1,
            _ => 0,
        };
        let next = self.empty_at(x, y, dx, -1).or_else(|| self.empty_at(x, y, 0, -1));
        let Some(p) = next else {
            self.set(i, STEM, 0);
            return;
        };
        if cur >= target {
            self.set(i, STEM, 0);
            self.bloom(p, seed, tick);
            return;
        }
        // Leaf and branch are decided at fixed heights, so each can happen at most once per stem.
        let rb = rng(seed, tick, xu, yu, SALT_STEM_BRANCH);
        if cur == 3 && rb % 3 == 0 {
            let side = if rb & 8 == 0 { -1 } else { 1 };
            if let Some(q) = self.empty_at(x, y, side, 0) {
                self.put_plant(q, STEM, 0);
            }
        }
        if cur == 5 && rb % 2 == 0 {
            let (side, bit) = if rb & 8 == 0 { (-1, 1) } else { (1, 2) };
            if let Some(q) = self.empty_at(x, y, side, 0) {
                let rem = 3 + (rb >> 4) % 3;
                self.put_plant(q, STEM, ((rem << 4) | bit) as u8);
            }
        }
        self.put_plant(p, STEM, ((target << 4) | (cur + 1)) as u8);
        self.set(i, STEM, 0);
    }

    fn grow_branch(&mut self, x: usize, y: usize, rem: u32, lo: u32, seed: u64, tick: u32) {
        let i = y * self.w + x;
        let side: isize = if lo == 1 { -1 } else { 1 };
        let up = rng(seed, tick, x as u32, y as u32, SALT_STEM_LEAN) % 2 == 0;
        let next = self.empty_at(x, y, side, if up { -1 } else { 0 });
        let Some(p) = next else {
            self.set(i, STEM, 0);
            return;
        };
        if rem == 1 {
            self.set(i, STEM, 0);
            self.put_plant(p, FLOWER, 0);
        } else {
            self.put_plant(p, STEM, (((rem - 1) << 4) | lo) as u8);
            self.set(i, STEM, 0);
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

    /// Plan 6.2 step 4: resolve this tick's queued explosions in queue order. Each centre that really
    /// detonates is also reported in `explosions` for the damage pass.
    fn resolve_explosions(&mut self, seed: u64, tick: u32) {
        let queue = core::mem::take(&mut self.pending);
        for &(cx, cy) in &queue {
            let ci = cy as usize * self.w + cx as usize;
            if self.mat[ci] != GUNPOWDER {
                continue;
            }
            self.explosions.push((cx, cy));
            self.carve(cx as i32, cy as i32, BLAST_RADIUS, seed, tick);
        }
    }

    /// Dig: clear solids and plants in the capsule of radius `r` (clamped to `DIG_RADIUS`) around the segment
    /// from (`ax`, `ay`) to (`bx`, `by`). Each segment component is clamped to `DIG_REACH` from the start, so the
    /// box is at most (reach + 2r + 1)^2 cells. Bedrock, liquids, fire, smoke and steam stay; Gunpowder is
    /// primed; no fire rim. Integers only: a cell is inside when its squared distance to the segment is at
    /// most r^2, compared without division as `|p * L2 - d * t|^2 <= r^2 * L2^2` (L2 = |d|^2, t = clamp(p.d)).
    pub fn dig(&mut self, ax: i32, ay: i32, bx: i32, by: i32, r: i32) {
        let r = r.clamp(0, DIG_RADIUS);
        let (dx, dy) = ((bx - ax).clamp(-DIG_REACH, DIG_REACH), (by - ay).clamp(-DIG_REACH, DIG_REACH));
        let l2 = i64::from(dx * dx + dy * dy);
        let (x0, x1) = (ax.min(ax + dx) - r, ax.max(ax + dx) + r);
        let (y0, y1) = (ay.min(ay + dy) - r, ay.max(ay + dy) + r);
        for y in y0.max(0)..=y1.min(self.h as i32 - 1) {
            for x in x0.max(0)..=x1.min(self.w as i32 - 1) {
                let (px, py) = (i64::from(x - ax), i64::from(y - ay));
                let t = (px * i64::from(dx) + py * i64::from(dy)).clamp(0, l2);
                let (ex, ey) = (px * l2 - i64::from(dx) * t, py * l2 - i64::from(dy) * t);
                let outside = if l2 == 0 { px * px + py * py > i64::from(r * r) } else { ex * ex + ey * ey > i64::from(r * r) * l2 * l2 };
                if outside {
                    continue;
                }
                let i = y as usize * self.w + x as usize;
                match self.mat[i] {
                    ROCK | DIRT | SAND | WOOD | SEED | STEM | FLOWER | ICE | GLASS | COAL => self.set(i, EMPTY, 0),
                    GUNPOWDER if self.aux[i] != 1 => self.set(i, GUNPOWDER, 1),
                    _ => {}
                }
            }
        }
    }

    /// Clear the disc of radius `r` around (`cx`, `cy`): bedrock stays, Gunpowder other than the centre
    /// cell is primed, everything else becomes Empty (or Fire on a third of the rim, by counter-based rng).
    /// Work is bounded by the (2r+1)^2 box clamped to the world.
    pub fn carve(&mut self, cx: i32, cy: i32, r: i32, seed: u64, tick: u32) {
        let ci = cy as usize * self.w + cx as usize;
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
                        let rim = d2 > (r - 1) * (r - 1) && rng(seed, tick, x as u32, y as u32, SALT_BLAST_RIM) % 3 == 0;
                        self.set(i, if rim { FIRE } else { EMPTY }, 0);
                    }
                }
            }
        }
    }
}

const GERMINATE_AT: u8 = 60;
/// Dissolves an acid cell can do before it is used up.
const ACID_STRENGTH: u8 = 12;
/// Waters one fresh Ice cell can freeze over its life.
const ICE_COLD: u8 = 3;
/// Ticks a lit Coal cell burns: about four times a Wood cell's fire (30..=90 ticks, mean 60).
const COAL_BURN: u8 = 240;
/// Lifetime of the fire a burning Gas cell becomes: short, so a pocket flashes through.
const FLASH_LIFE: u8 = 6;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dig_removes_solids_and_plants_only() {
        let mut g = Grid::new(64, 64);
        // All within radius 4 of (20, 30): nine on the centre row, four on the row above.
        let cells: Vec<(usize, usize)> = (16..=24).map(|x| (x, 30)).chain((18..=21).map(|x| (x, 29))).collect();
        let mats = [ROCK, DIRT, SAND, WOOD, SEED, STEM, FLOWER, BEDROCK, WATER, LAVA, FIRE, SMOKE, STEAM];
        for (&(x, y), &m) in cells.iter().zip(&mats) {
            g.set(y * 64 + x, m, 0);
        }
        g.dig(20, 30, 20, 30, 4);
        for (k, (&(x, y), &m)) in cells.iter().zip(&mats).enumerate() {
            let removed = k < 7;
            assert_eq!(g.at(x, y) == EMPTY && m != EMPTY, removed, "material {m} at {x},{y}");
            if !removed {
                assert_eq!(g.at(x, y), m);
            }
        }
    }

    #[test]
    fn dig_primes_gunpowder_without_fire_rim() {
        let mut g = Grid::new(64, 64);
        g.set(30 * 64 + 30, GUNPOWDER, 0);
        for x in 20..29 {
            g.set(30 * 64 + x, ROCK, 0);
        }
        g.dig(30, 30, 30, 30, 4);
        assert_eq!(g.mat[30 * 64 + 30], GUNPOWDER);
        assert_eq!(g.aux[30 * 64 + 30], 1);
        assert!((0..64 * 64).all(|i| g.mat[i] != FIRE));
    }

    #[test]
    fn dig_work_is_bounded_by_clamping_radius_and_reach() {
        let mut g = Grid::new(256, 256);
        for i in 0..256 * 256 {
            g.mat[i] = ROCK;
        }
        g.dig(128, 128, 128 + 10_000, 128 + 10_000, 10_000);
        let gone = g.mat.iter().filter(|&&m| m == EMPTY).count() as i32;
        let (r, k) = (DIG_RADIUS, DIG_REACH);
        assert!(gone > 0 && gone <= (k + 2 * r + 1) * (k + 2 * r + 1), "cleared {gone}");
        assert_eq!(g.at((128 + k + r + 1) as usize, 128), ROCK);
        assert_eq!(g.at(128, (128 + k + r + 1) as usize), ROCK);
    }

    #[test]
    fn dig_capsule_is_body_wide_and_reach_long() {
        let mut g = Grid::new(128, 128);
        for i in 0..128 * 128 {
            g.mat[i] = ROCK;
        }
        g.dig(20, 60, 20 + DIG_REACH, 60, DIG_RADIUS);
        // Along the aim: reach plus the end cap; across it: the full radius, no more.
        assert_eq!((g.at(20 - DIG_RADIUS as usize, 60), g.at(20 - DIG_RADIUS as usize - 1, 60)), (EMPTY, ROCK));
        assert_eq!((g.at(20 + (DIG_REACH + DIG_RADIUS) as usize, 60), g.at(20 + (DIG_REACH + DIG_RADIUS) as usize + 1, 60)), (EMPTY, ROCK));
        assert_eq!((g.at(30, 60 - DIG_RADIUS as usize), g.at(30, 60 - DIG_RADIUS as usize - 1)), (EMPTY, ROCK));
        assert_eq!((g.at(30, 60 + DIG_RADIUS as usize), g.at(30, 60 + DIG_RADIUS as usize + 1)), (EMPTY, ROCK));
    }

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
    fn oil_floats_on_water() {
        // Water starts above the oil; it must sink through it and the oil must rise to the top.
        let mut g = boxed(64, 64);
        for y in 40..50 {
            g.set(y * 64 + 5, WATER, 0);
        }
        for y in 50..60 {
            g.set(y * 64 + 5, OIL, 0);
        }
        // Walls so the column stays a column.
        for y in 0..64 {
            g.set(y * 64 + 4, BEDROCK, 0);
            g.set(y * 64 + 6, BEDROCK, 0);
        }
        run(&mut g, 1, 400);
        for y in 43..53 {
            assert_eq!(g.at(5, y), OIL, "row {y}");
        }
        for y in 53..63 {
            assert_eq!(g.at(5, y), WATER, "row {y}");
        }
    }

    #[test]
    fn oil_burns_fast_and_spreads_fire() {
        // A 40-wide, 4-deep pool in a basin, lit at one end: the fire must run the whole surface and
        // consume the oil, far faster than wood burns.
        let mut g = boxed(64, 64);
        for y in 56..63 {
            g.set(y * 64 + 4, BEDROCK, 0);
            g.set(y * 64 + 45, BEDROCK, 0);
        }
        for y in 59..63 {
            for x in 5..45 {
                g.set(y * 64 + x, OIL, 0);
            }
        }
        g.set(58 * 64 + 5, FIRE, 0);
        let mut done = None;
        for t in 0..600 {
            g.step_cells(2, t);
            if done.is_none() && count(&g, OIL) == 0 {
                done = Some(t);
            }
        }
        let t = done.unwrap_or_else(|| panic!("pool left {} oil", count(&g, OIL)));
        assert!(t < 400, "oil took {t} ticks to burn");
    }

    #[test]
    fn acid_eats_rock_and_stops_at_bedrock() {
        // A column of acid on a rock floor over bedrock: it digs down through the rock, never the bedrock.
        let mut g = Grid::new(64, 64);
        for x in 0..64 {
            g.set(63 * 64 + x, BEDROCK, 0);
            for y in 58..63 {
                g.set(y * 64 + x, ROCK, 0);
            }
        }
        for y in 40..58 {
            for x in 20..24 {
                g.set(y * 64 + x, ACID, 0);
            }
        }
        let rock0 = count(&g, ROCK);
        run(&mut g, 3, 600);
        assert!(count(&g, ROCK) < rock0, "acid should dissolve rock");
        assert_eq!(count(&g, BEDROCK), 64);
        assert!((0..64).all(|x| g.at(x, 63) == BEDROCK));
        // Each dissolve spends strength: acid is consumed.
        assert!(count(&g, ACID) < 18 * 4);
    }

    #[test]
    fn acid_dilutes_water() {
        let mut g = boxed(64, 64);
        g.set(62 * 64 + 10, ACID, 0);
        g.set(62 * 64 + 11, WATER, 0);
        run(&mut g, 3, 200);
        assert_eq!(count(&g, ACID), 0);
        assert_eq!(count(&g, WATER), 2);
    }

    #[test]
    fn gas_rises_and_lingers_under_a_ceiling() {
        let mut g = boxed(64, 64);
        for x in 0..64 {
            g.set(30 * 64 + x, BEDROCK, 0);
        }
        g.set(50 * 64 + 5, GAS, 0);
        run(&mut g, 3, 500);
        assert_eq!(count(&g, GAS), 1, "gas never expires");
        assert!((0..64).any(|x| g.at(x, 31) == GAS), "it rose to the ceiling");
    }

    #[test]
    fn gas_flash_burns_the_whole_pocket() {
        let mut g = boxed(64, 64);
        for y in 40..63 {
            g.set(y * 64 + 4, BEDROCK, 0);
            g.set(y * 64 + 45, BEDROCK, 0);
        }
        for x in 4..46 {
            g.set(40 * 64 + x, BEDROCK, 0);
        }
        for y in 41..45 {
            for x in 5..45 {
                g.set(y * 64 + x, GAS, 0);
            }
        }
        g.set(45 * 64 + 5, FIRE, 0);
        let mut done = None;
        for t in 0..300 {
            g.step_cells(2, t);
            if done.is_none() && count(&g, GAS) == 0 {
                done = Some(t);
            }
        }
        let t = done.unwrap_or_else(|| panic!("pocket left {} gas", count(&g, GAS)));
        assert!(t < 120, "flash fire took {t} ticks");
        assert_eq!(count(&g, FIRE), 0);
    }

    #[test]
    fn fire_melts_ice() {
        let mut g = boxed(64, 64);
        for x in 10..14 {
            g.set(62 * 64 + x, ICE, 0);
        }
        g.set(61 * 64 + 10, FIRE, 0);
        g.set(61 * 64 + 11, FIRE, 0);
        g.set(61 * 64 + 12, FIRE, 0);
        g.set(61 * 64 + 13, FIRE, 0);
        for x in 10..14 {
            g.set(60 * 64 + x, BEDROCK, 0); // a ceiling, so the fire stays on the ice
        }
        run(&mut g, 4, 100);
        // Fire beside the fresh meltwater turns to steam, so the last cell may survive; most must go.
        assert!(count(&g, ICE) <= 1, "fire should melt the ice");
        assert!(count(&g, WATER) + count(&g, STEAM) > 0);
    }

    #[test]
    fn lava_melts_ice() {
        let mut g = boxed(64, 64);
        for x in 9..12 {
            g.set(61 * 64 + x, ROCK, 0);
        }
        g.set(62 * 64 + 11, LAVA, 0);
        g.set(62 * 64 + 12, ICE, 0);
        g.set(61 * 64 + 12, BEDROCK, 0);
        g.set(62 * 64 + 13, BEDROCK, 0);
        run(&mut g, 4, 60);
        assert_eq!(count(&g, ICE), 0);
    }

    #[test]
    fn water_freezes_slowly_and_only_within_the_ice_cold_budget() {
        // One ice cell in a big pool of water: it may freeze at most ICE_COLD neighbours, over time.
        let mut g = boxed(64, 64);
        for y in 50..63 {
            g.set(y * 64 + 9, BEDROCK, 0);
            g.set(y * 64 + 40, BEDROCK, 0);
        }
        for y in 55..63 {
            for x in 10..40 {
                g.set(y * 64 + x, WATER, 0);
            }
        }
        g.set(58 * 64 + 20, ICE, 0);
        g.step_cells(5, 0);
        assert_eq!(count(&g, ICE), 1, "not instant");
        run(&mut g, 5, 2000);
        let n = count(&g, ICE);
        assert!(n > 1, "some water should freeze");
        assert!(n <= 1 + ICE_COLD as usize, "freezing is capped, got {n} ice");
    }

    #[test]
    fn lava_turns_sand_to_glass_and_glass_is_inert_and_diggable() {
        let mut g = boxed(64, 64);
        g.set(62 * 64 + 10, SAND, 0);
        g.set(62 * 64 + 12, BEDROCK, 0);
        g.set(62 * 64 + 11, LAVA, 0);
        g.set(61 * 64 + 11, ROCK, 0);
        g.set(61 * 64 + 10, ROCK, 0);
        run(&mut g, 4, 200);
        assert_eq!(g.at(10, 62), GLASS);
        g.set(60 * 64 + 20, GLASS, 0);
        g.set(60 * 64 + 21, ICE, 0);
        g.dig(20, 60, 21, 60, 1);
        assert_eq!((g.at(20, 60), g.at(21, 60)), (EMPTY, EMPTY));
    }

    #[test]
    fn coal_burns_long_and_gives_off_smoke() {
        // One lit coal cell burns far longer than a wood cell does, and sheds fire and smoke.
        let burn = |m: u8| {
            let mut g = boxed(64, 64);
            for x in 20..25 {
                g.set(62 * 64 + x, m, 0);
            }
            for y in 0..62 {
                g.set(y * 64 + 19, BEDROCK, 0);
                g.set(y * 64 + 25, BEDROCK, 0);
            }
            g.set(61 * 64 + 20, FIRE, 0);
            let (mut gone, mut saw_smoke) = (None, false);
            for t in 0..2000 {
                g.step_cells(6, t);
                saw_smoke |= count(&g, SMOKE) > 0;
                if gone.is_none() && count(&g, m) == 0 {
                    gone = Some(t);
                }
            }
            (gone, saw_smoke)
        };
        let (coal, smoke) = burn(COAL);
        let (wood, _) = burn(WOOD);
        let (coal, wood) = (coal.expect("coal should burn out"), wood.expect("wood should burn out"));
        assert!(smoke, "burning coal gives off smoke");
        assert!(coal > 2 * wood, "coal burned {coal} ticks, wood {wood}");
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
        let plants = (0..64 * 62).filter(|&i| g.mat[i] == STEM || g.mat[i] == FLOWER).count();
        assert!((9..=60).contains(&plants), "plant size {plants}");
        assert!(count(&g, FLOWER) >= 1);
    }

    /// A dirt strip with one seed and water beside it, run to completion; returns the plant's cells.
    fn grow_plant(seed: u64) -> Vec<(usize, usize, u8)> {
        let mut g = boxed(64, 64);
        for x in 0..64 {
            g.set(62 * 64 + x, DIRT, 0);
        }
        g.set(61 * 64 + 30, SEED, 0);
        g.set(61 * 64 + 32, WATER, 0);
        run(&mut g, seed, 4000);
        let mut cells = Vec::new();
        for y in 0..62 {
            for x in 0..64 {
                let m = g.at(x, y);
                if m == STEM || m == FLOWER {
                    assert!(m != STEM || g.aux[y * 64 + x] == 0, "unfinished tip at {x},{y}");
                    cells.push((x, y, m));
                }
            }
        }
        cells
    }

    #[test]
    fn plants_are_bounded_vary_in_shape_and_repeat_per_seed() {
        let mut shapes = std::collections::BTreeSet::new();
        for seed in 0..40u64 {
            let c = grow_plant(seed);
            // Main stem 8-14, a leaf, one branch of up to 5 cells, a bloom of up to 4 cells.
            assert!((9..=30).contains(&c.len()), "seed {seed}: {} cells", c.len());
            assert!(c.iter().any(|&(_, _, m)| m == FLOWER), "seed {seed}: no flower");
            let flowers = c.iter().filter(|&&(_, _, m)| m == FLOWER).count();
            let stems = c.len() - flowers;
            shapes.insert((flowers, c.iter().map(|&(x, _, _)| x).min().unwrap() != 30, stems > 14));
            assert_eq!(c, grow_plant(seed), "same seed must grow the same plant");
        }
        assert!(shapes.len() >= 4, "plants too alike: {shapes:?}");
        let all_flowers: std::collections::BTreeSet<usize> =
            (0..40u64).map(|s| grow_plant(s).iter().filter(|c| c.2 == FLOWER).count()).collect();
        assert!(all_flowers.len() >= 2, "one bloom shape only: {all_flowers:?}");
    }

    /// D-084: stems saved under D-024's encoding (`target << 4 | height`) and any odd byte must
    /// finish as some plant, never grow without bound, and leave no growing tip behind.
    #[test]
    fn old_encoded_stems_finish() {
        for aux in [0x81u8, 0xE1, 0xA7, 0xEE, 0xF1, 0xFF, 0x05, 0x13, 0x77, 0x01] {
            let mut g = boxed(64, 64);
            g.set(40 * 64 + 20, STEM, aux);
            run(&mut g, 5, 6000);
            let plant = count(&g, STEM) + count(&g, FLOWER);
            assert!(plant <= 40, "aux {aux:#x}: {plant} cells");
            assert!((0..64 * 64).all(|i| g.mat[i] != STEM || g.aux[i] == 0), "aux {aux:#x}: tip left growing");
        }
    }

    #[test]
    fn growing_stem_keeps_its_chunk_awake_and_mature_plants_sleep() {
        let mut g = boxed(64, 64);
        g.set(40 * 64 + 20, STEM, 0xC1);
        g.step_cells(1, 0);
        assert!(g.awake[g.chunk_of(20, 40)]);
        run(&mut g, 1, 6000);
        for t in 6000..6003 {
            g.step_cells(1, t);
        }
        assert_eq!(g.ran_chunks, 0, "a finished plant must let its chunks sleep");
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
        for m in (0u8..=COAL).filter(|&m| m != BEDROCK) {
            assert!(paintable(m), "{m}");
        }
        assert!(!paintable(BEDROCK) && !paintable(COAL + 1));
    }
}

#[cfg(test)]
mod lava_levels {
    use super::*;

    fn lava_column(sleep: bool) -> Grid { column(sleep, LAVA) }
    fn column(sleep: bool, mat: u8) -> Grid {
        let (w, h) = (384, 192);
        let mut g = Grid::new(w, h);
        g.set_all_active();
        g.sleep_enabled = sleep;
        for x in 0..w {
            g.set((h - 1) * w + x, BEDROCK, 0);
        }
        for y in 0..h {
            g.set(y * w + w - 1, BEDROCK, 0);
            g.set(y * w, BEDROCK, 0);
        }
        // A tall column of lava against the right wall, as in the bug screenshot.
        for y in 20..h - 1 {
            for x in w - 60..w - 1 {
                g.set(y * w + x, mat, 0);
            }
        }
        for t in 0..6000 {
            g.step_cells(7, t);
        }
        g
    }

    fn surface(g: &Grid) -> Vec<usize> { surface_of(g, LAVA) }
    fn surface_of(g: &Grid, m: u8) -> Vec<usize> {
        (1..g.w - 1).map(|x| (0..g.h).find(|&y| g.mat[y * g.w + x] == m).unwrap_or(g.h)).collect()
    }

    #[test]
    fn water_levels_out() {
        let g = column(true, WATER);
        let s = surface_of(&g, WATER);
        let spread = s.iter().max().unwrap() - s.iter().min().unwrap();
        assert!(spread <= 2, "water surface spans {spread} rows; a liquid should level");
    }

    #[test]
    fn lava_settles_the_same_with_sleeping_on_and_off() {
        let (on, off) = (lava_column(true), lava_column(false));
        let (son, soff) = (surface(&on), surface(&off));
        let spread = |s: &[usize]| s.iter().max().unwrap() - s.iter().min().unwrap();
        assert_eq!(on.mat, off.mat, "sleeping changed the result (invariant 8)");
        // The reported bug: a heap of lava settled into a staircase on chunk edges, 48 rows high.
        assert!(spread(&son) <= 2, "lava surface spans {} rows; a liquid should level", spread(&son));
        let _ = soff;
    }
}

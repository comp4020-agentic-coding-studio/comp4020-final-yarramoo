//! The simulation instance: grid + tick + queued inputs.

use crate::entities::{self, Event, Pickup, Player, Projectile, EV_PICKUP, EV_SPAWN};
use crate::grid::Grid;
use crate::hash;
use crate::input::{decode, Input};
use crate::materials::*;
use crate::rng::{rng, SALT_PICKUP_SPELL, SALT_SPAWN_X};
use crate::tuning::*;

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
    /// Player entities, sorted by id (game worlds only; the sandbox has none). State: hashed and snapshotted.
    pub players: Vec<Player>,
    /// Pickups created by generation, in id order (game worlds only). State.
    pub pickups: Vec<Pickup>,
    /// Bolts in flight, in spawn order (game worlds only). State: hashed and snapshotted.
    pub projectiles: Vec<Projectile>,
    /// Scratch: events from the last step, for the render-only `events()` view. Never an input.
    pub events: Vec<Event>,
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
            let pickups = spots
                .iter()
                .enumerate()
                .map(|(i, sp)| {
                    // Shallow spots give Water or Rose seed, deep spots Fire bolt or Bomb (plan 6.7).
                    let pick = (rng(seed, 0, i as u32, 0, SALT_PICKUP_SPELL) & 1) as u8;
                    let spell = 2 + 2 * sp.band + pick;
                    Pickup { id: i as u16, spell, x: sp.x, y: sp.y, charges: PICKUP_CHARGES[spell as usize], respawn_at: 0 }
                })
                .collect();
            return Some(Sim { seed, world_kind, tick: 0, grid, queue: Vec::new(), players: Vec::new(), pickups, projectiles: Vec::new(), events: Vec::new() });
        }
        for y in 0..h {
            for x in 0..w {
                if y >= h - FLOOR_ROWS || x < WALL_COLS || x >= w - WALL_COLS {
                    grid.mat[y * w + x] = BEDROCK;
                }
            }
        }
        Some(Sim { seed, world_kind, tick: 0, grid, queue: Vec::new(), players: Vec::new(), pickups: Vec::new(), projectiles: Vec::new(), events: Vec::new() })
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
        self.events.clear();
        let inputs = core::mem::take(&mut self.queue);
        for i in inputs {
            self.apply(i);
        }
        self.update_entities();
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

    /// Plan 6.5 active set. Sandbox: every chunk. Game world: chunks that intersect the 576 x 320
    /// rectangle around an ACTIVE player's official position; with no active player nothing updates
    /// (the world is frozen). The centres come from entity state, which is hashed and snapshotted, so
    /// every client agrees on the set.
    fn refresh_active(&mut self) {
        if self.world_kind == 0 {
            self.grid.set_all_active();
            return;
        }
        let centres: Vec<(i32, i32)> =
            self.players.iter().filter(|p| p.active).map(|p| (p.x >> POS_SHIFT, p.y >> POS_SHIFT)).collect();
        self.grid.set_active_around(&centres);
    }

    fn player_index(&self, id: u32) -> Result<usize, usize> {
        self.players.binary_search_by_key(&id, |p| p.id)
    }

    fn apply(&mut self, i: Input) {
        match i {
            Input::Paint { mat, x0, y0, x1, y1, radius, .. } => {
                if self.world_kind == 0 || cfg!(feature = "dev_paint") {
                    self.paint(mat, x0 as i32, y0 as i32, x1 as i32, y1 as i32, radius as i32);
                }
            }
            // Players live in game worlds only: a sandbox visitor has no entity to grow without bound.
            Input::Join { .. } | Input::Leave { .. } | Input::Pos { .. } | Input::Cast { .. } if self.world_kind == 0 => {}
            Input::Join { player } => self.join(player),
            Input::Leave { player } => {
                if let Ok(k) = self.player_index(player) {
                    self.players[k].active = false;
                }
            }
            Input::Pos { player, life, x, y, facing } => {
                if let Ok(k) = self.player_index(player) {
                    let p = &mut self.players[k];
                    // A stale `life` is ignored, so a dead avatar's old position cannot override a respawn.
                    // An inactive player is ignored too. Clamped to the world: the work stays bounded.
                    if p.active && p.life == life {
                        p.x = x.clamp(0, (self.grid.w as i32 - 1) * POS_ONE);
                        p.y = y.clamp(0, (self.grid.h as i32 - 1) * POS_ONE);
                        p.facing = facing & 1;
                    }
                }
            }
            Input::Cast { player, spell, angle, cast_seq } => self.cast(player, spell, angle, cast_seq),
        }
    }

    fn join(&mut self, id: u32) {
        if id == 0 {
            return;
        }
        let k = match self.player_index(id) {
            Ok(k) => k,
            Err(at) => {
                if self.players.len() >= MAX_PLAYERS {
                    return;
                }
                let (x, y) = self.spawn_point(id);
                self.players.insert(at, Player::new(id, x, y));
                at
            }
        };
        let p = &mut self.players[k];
        p.active = true;
        let ev = Event { kind: EV_SPAWN, player: id, a: p.x, b: p.y, c: i32::from(p.life) };
        self.events.push(ev);
    }

    /// Centre of the surface plus an rng offset: the first column from a few candidates whose hitbox
    /// has clear air above solid ground (trees and overhangs are skipped). Pure function of state.
    pub(crate) fn spawn_point(&self, id: u32) -> (i32, i32) {
        let g = &self.grid;
        let (w, h) = (g.w as i32, g.h as i32);
        let first = (rng(self.seed, self.tick, id, 0, SALT_SPAWN_X) % (2 * SPAWN_JITTER + 1)) as i32 - SPAWN_JITTER as i32;
        let mut best = (w / 2 * POS_ONE + POS_ONE / 2, (h / 2) * POS_ONE);
        for k in 0..16 {
            let col = (w / 2 + first + 7 * k).clamp(3, w - 4);
            let Some(ground) = (0..h).find(|&y| matches!(g.mat[(y * w + col) as usize], DIRT | ROCK | SAND | BEDROCK)) else {
                continue;
            };
            let clear = ground >= HITBOX_H
                && (col - 2..=col + 2).all(|x| (ground - HITBOX_H..ground).all(|y| g.mat[(y * w + x) as usize] == EMPTY));
            best = (col * POS_ONE + POS_ONE / 2, ground * POS_ONE);
            if clear {
                break;
            }
        }
        best
    }

    /// Plan 6.2 step 2: pickups (players move only through Pos inputs). Players by id, pickups by id,
    /// so two players on one pickup resolve to the lower id.
    fn update_entities(&mut self) {
        self.update_projectiles();
        if self.pickups.is_empty() {
            return;
        }
        let tick = self.tick;
        for p in self.players.iter_mut().filter(|p| p.active) {
            let (x0, y0, x1, y1) = p.hitbox_cells();
            for k in self.pickups.iter_mut() {
                let (kx, ky) = (i32::from(k.x), i32::from(k.y));
                if tick < k.respawn_at || kx < x0 || kx > x1 || ky < y0 || ky > y1 {
                    continue;
                }
                let c = &mut p.charges[k.spell as usize];
                if *c != INFINITE {
                    *c = c.saturating_add(k.charges).min(INFINITE - 1);
                }
                k.respawn_at = tick.wrapping_add(PICKUP_RESPAWN);
                self.events.push(Event { kind: EV_PICKUP, player: p.id, a: i32::from(k.id), b: i32::from(k.spell), c: i32::from(k.charges) });
            }
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

    /// Canonical entity bytes (plan 6.10): players by id, then pickups. In the state hash and snapshots.
    pub fn entity_bytes(&self) -> Vec<u8> {
        if self.world_kind == 0 {
            return Vec::new(); // the sandbox has no entities, and its hashes stay what they were
        }
        entities::encode(&self.players, &self.pickups, &self.projectiles)
    }

    pub fn state_hash(&mut self) -> u64 {
        let e = self.entity_bytes();
        hash::state_hash(&mut self.grid, self.tick, &e)
    }
}

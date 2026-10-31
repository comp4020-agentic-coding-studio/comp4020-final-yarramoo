//! The simulation instance: grid + tick + queued inputs.

use crate::config::{IntoRoom, RoomConfig, CONFIG_BYTES, TERRAIN_CAVES, TERRAIN_EMPTY_BOX, TERRAIN_SOLID_BOX};
use crate::entities::{self, Bag, Enemy, Event, Pickup, Player, Projectile, EV_PICKUP, EV_ROUND_END, EV_SPAWN};
use crate::grid::Grid;
use crate::hash;
use crate::input::{decode, Input};
use crate::materials::*;
use crate::rng::{rng, SALT_PICKUP_SPELL, SALT_SPAWN_X};
use crate::tuning::*;

const FLOOR_ROWS: usize = 16;
const WALL_COLS: usize = 16;
pub const MAX_PAINT_RADIUS: i32 = 32;

/// The pristine generated world for one (seed, config): derived data, not state. It is never hashed or
/// snapshotted, so a hit and a miss give identical results (D-088). Generated (cave) worlds only; one per instance.
pub struct Base {
    pub seed: u64,
    pub cfg: [u8; CONFIG_BYTES],
    pub mat: Vec<u8>,
    pub aux: Vec<u8>,
    pub pickups: Vec<Pickup>,
    pub enemies: Vec<Enemy>,
    pub arena: Option<crate::gen::Arena>,
}

pub struct Sim {
    pub seed: u64,
    pub cfg: RoomConfig,
    pub tick: u32,
    pub grid: Grid,
    queue: Vec<Input>,
    /// Player entities, sorted by id (game worlds only; the sandbox has none). State: hashed and snapshotted.
    pub players: Vec<Player>,
    /// Pickups created by generation, in id order (game worlds only). State.
    pub pickups: Vec<Pickup>,
    /// Bolts in flight, in spawn order (game worlds only). State: hashed and snapshotted.
    pub projectiles: Vec<Projectile>,
    /// Dropped bags, in spawn order (game worlds only; the sandbox has none). State: hashed and snapshotted.
    pub bags: Vec<Bag>,
    /// Enemies, sorted by id (Survival only). State: hashed and snapshotted. Placed by the generator, never spawned later.
    pub enemies: Vec<Enemy>,
    /// Scratch: cells examined by enemy collision this tick (the work count the report measures). Not state.
    pub enemy_work: u32,
    /// The boss arena (Survival worlds). Derived from the seed by the generator, never hashed or snapshotted.
    pub arena: Option<crate::gen::Arena>,
    /// 1 once the one-life round has ended (`EV_ROUND_END` fired). State: hashed and snapshotted.
    pub round_over: u8,
    /// 1 once the first enemy kill or the first player death has happened in a one-life round (D-161). State.
    pub round_started: u8,
    /// 1 if the round ended in a win, 0 for a loss (meaningful once `round_over` is 1). State.
    pub round_result: u8,
    /// Scratch: events from the last step, for the render-only `events()` view. Never an input.
    pub events: Vec<Event>,
    /// Cache of the generated world, so `restore` need not regenerate it. Not state.
    pub base: Option<Base>,
}

impl Sim {
    /// Generate a world, tick = 0. Every (terrain, size) combination generates (R1): Caves, Solid box and
    /// Empty box all exist at S, M and L. Returns None only via `IntoRoom`, for an unknown world kind.
    pub fn new(seed: u64, cfg: impl IntoRoom) -> Option<Sim> {
        Self::new_with_base(seed, cfg, None)
    }

    /// As `new`, but a cave world whose (seed, config) matches `base` is copied from it instead of generated.
    pub fn new_with_base(seed: u64, cfg: impl IntoRoom, base: Option<&Base>) -> Option<Sim> {
        let cfg = cfg.into_room()?;
        let (w, h) = cfg.dims();
        let bytes = cfg.encode();
        let mut grid = Grid::new(w, h);
        let make = |grid: Grid, pickups: Vec<Pickup>, enemies: Vec<Enemy>, arena: Option<crate::gen::Arena>, base: Option<Base>| Sim { seed, cfg, tick: 0, grid, queue: Vec::new(), players: Vec::new(), pickups, projectiles: Vec::new(), bags: Vec::new(), enemies, round_over: 0, round_started: 0, round_result: 0, enemy_work: 0, arena, events: Vec::new(), base };
        match cfg.terrain {
            TERRAIN_CAVES => {
                if let Some(b) = base.filter(|b| b.seed == seed && b.cfg == bytes && b.mat.len() == w * h && b.aux.len() == w * h) {
                    grid.mat.copy_from_slice(&b.mat);
                    grid.aux.copy_from_slice(&b.aux);
                    return Some(make(grid, b.pickups.clone(), b.enemies.clone(), b.arena, None));
                }
                let world = crate::gen::generate_world(&mut grid, seed, cfg.has_enemies());
                let (spots, arena) = (world.spots, world.arena);
                let pickups: Vec<Pickup> = spots
                    .iter()
                    .enumerate()
                    .map(|(i, sp)| {
                        // Each band has its own weighted table (F3): shallow gives the utility spells, deep the rarer ones.
                        let table = PICKUP_TABLE[usize::from(sp.band != 0)];
                        let total: u32 = table.iter().map(|&(_, w)| w).sum();
                        let mut roll = rng(seed, 0, i as u32, 0, SALT_PICKUP_SPELL) % total;
                        let spell = table
                            .iter()
                            .find(|&&(_, w)| {
                                if roll < w {
                                    true
                                } else {
                                    roll -= w;
                                    false
                                }
                            })
                            .map_or(table[0].0, |&(k, _)| k);
                        let spell = sp.fixed.unwrap_or(spell);
                        Pickup { id: i as u16, spell, x: sp.x, y: sp.y, charges: PICKUP_CHARGES[spell as usize], respawn_at: 0 }
                    })
                    .collect();
                // F4 (D-157): the generator places the slimes once; they join the cached base like pickups.
                let enemies: Vec<Enemy> = if cfg.has_enemies() {
                    let at: Vec<(u16, u16)> = pickups.iter().map(|p| (p.x, p.y)).collect();
                    let mut v: Vec<Enemy> = crate::gen::enemy_spots(&grid, seed, &at, arena.as_ref())
                        .iter()
                        .enumerate()
                        .map(|(i, &(x, y, kind))| Enemy::new(i as u16, kind, i32::from(x) * POS_ONE + POS_ONE / 2, (i32::from(y) + 1) * POS_ONE))
                        .collect();
                    // F6: exactly one boss per Survival world, at the arena centre, hovering `BOSS_HOVER` cells above the floor.
                    // It gets the highest placed id (so ids stay sorted); `stepping_set` steps it first, so id order never starves it.
                    if let Some(a) = &arena {
                        let mut boss = Enemy::new(v.len() as u16, ENEMY_BOSS, a.cx * POS_ONE + POS_ONE / 2, (a.floor_y - BOSS_HOVER) * POS_ONE);
                        boss.state = 1 << 2;
                        v.push(boss);
                    }
                    v
                } else {
                    Vec::new()
                };
                let base = Base { seed, cfg: bytes, mat: grid.mat.clone(), aux: grid.aux.clone(), pickups: pickups.clone(), enemies: enemies.clone(), arena };
                Some(make(grid, pickups, enemies, arena, Some(base)))
            }
            TERRAIN_EMPTY_BOX => {
                // The classic canvas: bedrock floor and side walls, at every size (R1).
                for y in 0..h {
                    for x in 0..w {
                        if y >= h - FLOOR_ROWS || x < WALL_COLS || x >= w - WALL_COLS {
                            grid.mat[y * w + x] = BEDROCK;
                        }
                    }
                }
                Some(make(grid, Vec::new(), Vec::new(), None, None))
            }
            TERRAIN_SOLID_BOX => {
                // Dirt over Rock, for digging and carving (plan-game-modes "Config fields"): a shallow Dirt
                // layer under the sky, Rock below it, Bedrock floor and side walls (the same convention
                // TERRAIN_EMPTY_BOX uses). No gen v2: this is a static layered fill, not a cave algorithm.
                let dirt_depth = (h / 6).clamp(20, 120);
                for y in 0..h {
                    for x in 0..w {
                        let m = if y >= h - FLOOR_ROWS || x < WALL_COLS || x >= w - WALL_COLS {
                            BEDROCK
                        } else if y < FLOOR_ROWS {
                            EMPTY
                        } else if y < FLOOR_ROWS + dirt_depth {
                            DIRT
                        } else {
                            ROCK
                        };
                        grid.mat[y * w + x] = m;
                    }
                }
                Some(make(grid, Vec::new(), Vec::new(), None, None))
            }
            _ => None,
        }
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

    /// One tick, in this order (D-102):
    /// 1. inputs
    /// 2. `update_entities`: projectiles, then enemies (F4), then respawns, then bags (expire, fall, take), then pickups
    /// 3. `refresh_active`
    /// 4. `grid.step_cells`
    /// 5. grid explosions -> `explode_at` (damage, knockback, `EV_EXPLODE`)
    /// 6. hazard scan (lava, fire contact), then the same for enemies
    ///
    /// Damage and death happen inside 5 and 6.
    pub fn step(&mut self) -> u32 {
        self.events.clear();
        let inputs = core::mem::take(&mut self.queue);
        for i in inputs {
            self.apply(i);
        }
        self.update_entities();
        self.refresh_active();
        self.grid.step_cells(self.seed, self.tick);
        if self.cfg.has_players() {
            let centres = core::mem::take(&mut self.grid.explosions);
            for &(cx, cy) in &centres {
                self.explode_at(cx as i32, cy as i32, crate::grid::BLAST_RADIUS, 0, CAUSE_GUNPOWDER);
            }
            self.grid.explosions = centres;
            self.hazard_scan();
            self.enemy_hazard_scan();
            self.check_round_end();
        }
        self.grid.crumble_islands();
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

    /// D-160: a one-life round (`round` 1) is lost when at least one player is active and every active player is
    /// dead (see below). Fires `EV_ROUND_END { a: 0 }` exactly once (`round_over` is hashed), after which enemies stop. A
    /// player who leaves does not by itself end the round (a reconnect must find it running); the win comes with
    /// the boss slice: `round_won` below is the hook, always false until then.
    fn check_round_end(&mut self) {
        if self.cfg.round != 1 || self.round_over != 0 {
            return;
        }
        // Lost: everyone who ever joined is dead (`health == 0`, whatever `active` says). A living player who
        // disconnected still counts as alive, so a dropped connection never ends the round (D-160).
        let lost = !self.players.is_empty() && self.players.iter().all(|p| p.health == 0);
        let won = self.round_won();
        if won || lost {
            self.round_over = 1;
            self.round_result = u8::from(won);
            self.events.push(Event { kind: EV_ROUND_END, player: 0, a: i32::from(won), b: 0, c: 0 });
        }
    }

    /// D-158: the boss's death wins the round. `reap_enemies` sets bit 1 of the hashed `round_started` byte when a boss
    /// dies (no new field, no format bump; bit 0 stays the D-161 first-kill flag). A restored snapshot,
    /// including one taken after the win, therefore says the same thing. A win and the last player's death on the same
    /// tick count as a win: `check_round_end` lets `won` take precedence over `lost`.
    fn round_won(&self) -> bool {
        self.round_started & ROUND_BOSS_KILLED != 0
    }

    /// Plan 6.5 active set. Sandbox: every chunk. Game world: chunks that intersect the 576 x 320
    /// rectangle around an ACTIVE player's official position; with no active player nothing updates
    /// (the world is frozen). The centres come from entity state, which is hashed and snapshotted, so
    /// every client agrees on the set.
    fn refresh_active(&mut self) {
        if !self.cfg.has_players() {
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
            Input::Paint { mat, x0, y0, x1, y1, radius, fill_empty, .. } => {
                if self.cfg.paint_allowed() || cfg!(feature = "dev_paint") {
                    self.paint(mat, x0 as i32, y0 as i32, x1 as i32, y1 as i32, radius as i32, fill_empty);
                }
            }
            // Players live in game worlds only: a sandbox visitor has no entity to grow without bound.
            Input::Join { .. } | Input::Leave { .. } | Input::Pos { .. } | Input::Cast { .. } if !self.cfg.has_players() => {}
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
                    // A dead player (health 0) is ignored as well: the corpse stays where it fell, and a
                    // client that keeps sending Pos while dead cannot move it before the respawn.
                    if p.active && p.health > 0 && p.life == life {
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
        // An id with the enemy-owner bit could be mistaken for an enemy bolt's owner: refused.
        if id == 0 || id & ENEMY_OWNER != 0 {
            return;
        }
        let k = match self.player_index(id) {
            Ok(k) => k,
            Err(at) => {
                if self.players.len() >= MAX_PLAYERS {
                    return;
                }
                let (x, y) = self.spawn_point(id);
                let mut p = Player::new(id, x, y);
                if self.cfg.all_spells() {
                    // Creative: every spell unlimited, reusing the same INFINITE sentinel Push/Blast
                    // already use (D-109's bag rules), rather than inventing a second "unlimited"
                    // concept. Every charge check and decrement already special-cases INFINITE.
                    p.charges = [INFINITE; NUM_SPELLS];
                }
                // D-161: in a one-life round, a player whose first Join comes after the round started (first enemy
                // kill or first player death) or ended joins already dead and spectates.
                if self.cfg.round == 1 && (self.round_started != 0 || self.round_over != 0) {
                    p.health = 0;
                    p.dead_until = u32::MAX;
                }
                self.players.insert(at, p);
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
        self.update_enemies();
        let tick = self.tick;
        // Respawns come first, in id order, whether or not the player is still active: a player who
        // left while dead must not stay dead.
        for k in 0..self.players.len() {
            let p = &self.players[k];
            if p.health == 0 && tick >= p.dead_until {
                let id = p.id;
                self.respawn_player(id);
            }
        }
        self.update_bags();
        if self.pickups.is_empty() {
            return;
        }
        for p in self.players.iter_mut().filter(|p| p.alive(tick)) {
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

    #[allow(clippy::too_many_arguments)] // one argument per wire field of the decoded Paint input
    fn paint(&mut self, mat: u8, x0: i32, y0: i32, x1: i32, y1: i32, r: i32, fill_empty: bool) {
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
            self.disc(mat, cx, cy, r, fill_empty);
        }
    }

    /// `fill_empty` (R4, plan-game-modes.md "Paint modes"): skip any cell that is not currently writable
    /// under `fill_empty_writable` (Empty or a gas), so a stroke never overwrites a solid or liquid.
    /// This only skips writes within the same already-bounded disc: no extra pass, no new loop.
    fn disc(&mut self, mat: u8, cx: i32, cy: i32, r: i32, fill_empty: bool) {
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        for y in (cy - r).max(0)..=(cy + r).min(h - 1) {
            for x in (cx - r).max(0)..=(cx + r).min(w - 1) {
                let (ax, ay) = (x - cx, y - cy);
                if ax * ax + ay * ay > r * r {
                    continue;
                }
                let i = (y * w + x) as usize;
                let cur = self.grid.mat[i];
                if cur == BEDROCK || (fill_empty && !fill_empty_writable(cur)) {
                    continue;
                }
                self.grid.set(i, mat, 0);
            }
        }
    }

    /// Canonical entity bytes (plan 6.10): players by id, then pickups. In the state hash and snapshots.
    pub fn entity_bytes(&self) -> Vec<u8> {
        if !self.cfg.has_players() {
            return Vec::new(); // the sandbox has no entities, and its hashes stay what they were
        }
        entities::encode(&self.players, &self.pickups, &self.projectiles, &self.bags, &self.enemies, [self.round_over, self.round_started, self.round_result])
    }

    pub fn state_hash(&mut self) -> u64 {
        let e = self.entity_bytes();
        hash::state_hash(&mut self.grid, self.tick, &self.cfg.encode(), &e)
    }
}

//! The simulation instance: grid + tick + queued inputs.

use crate::config::{IntoRoom, RoomConfig, CONFIG_BYTES, TERRAIN_CAVES, TERRAIN_EMPTY_BOX, TERRAIN_SOLID_BOX};
use crate::entities::{self, Bag, Enemy, Event, Heal, Pickup, Player, Projectile, EV_PICKUP, EV_ROUND_END, EV_ROUND_START, EV_SPAWN};
use crate::grid::{is_structural, Grid};
use crate::hash;
use crate::input::{decode, Input};
use crate::materials::*;
use crate::rng::{rng, SALT_PAINT_SEED, SALT_PICKUP_SPELL, SALT_SPAWN_X};
use crate::tuning::*;

const FLOOR_ROWS: usize = 16;
const WALL_COLS: usize = 16;
pub const MAX_PAINT_RADIUS: i32 = 32;

/// Highest stamp index for a stroke of Chebyshev length `n`: `min(n, MAX_PAINT_STROKE)`. A stroke makes this + 1 stamps.
pub fn paint_stamps(n: i32) -> i32 {
    n.min(crate::tuning::MAX_PAINT_STROKE)
}

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
    /// Paint work left this tick (review H2): reset at the start of every `step`, so it is never state.
    paint_budget: i64,
    /// Player entities, sorted by id (game worlds only; the sandbox has none). State: hashed and snapshotted.
    pub players: Vec<Player>,
    /// Pickups created by generation, in id order (game worlds only). State.
    pub pickups: Vec<Pickup>,
    /// Bolts in flight, in spawn order (game worlds only). State: hashed and snapshotted.
    pub projectiles: Vec<Projectile>,
    /// Dropped bags, in spawn order (game worlds only; the sandbox has none). State: hashed and snapshotted.
    pub bags: Vec<Bag>,
    /// Heals dropped by killed enemies, in spawn order (Survival only). State: hashed and snapshotted.
    pub heals: Vec<Heal>,
    /// Enemies, sorted by id (Survival only). State: hashed and snapshotted. Placed by the generator, never spawned later.
    pub enemies: Vec<Enemy>,
    /// Scratch: cells examined by enemy collision this tick (the work count the report measures). Not state.
    pub enemy_work: u32,
    /// The boss arena (Survival worlds). Derived from the seed by the generator, never hashed or snapshotted.
    pub arena: Option<crate::gen::Arena>,
    /// 1 once the one-life round has ended (`EV_ROUND_END` fired). State: hashed and snapshotted.
    pub round_over: u8,
    /// 1 once the lobby countdown has completed and the one-life round is running (F6b, D-166). State.
    pub round_running: u8,
    /// 1 once the boss has died (the Survival win, D-158). State.
    pub boss_killed: u8,
    /// 1 if the round ended in a win, 0 for a loss (meaningful once `round_over` is 1). State.
    pub round_result: u8,
    /// F6b (D-166): the tick the lobby countdown began (every active player ready), or `LOBBY_IDLE`. State.
    pub lobby_since: u32,
    /// F6b (S3): the tick a strict majority of active players became ready, or `LOBBY_IDLE`. State.
    pub majority_since: u32,
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
        let make = |grid: Grid, pickups: Vec<Pickup>, enemies: Vec<Enemy>, arena: Option<crate::gen::Arena>, base: Option<Base>| Sim { seed, cfg, tick: 0, grid, queue: Vec::new(), paint_budget: 0, players: Vec::new(), pickups, projectiles: Vec::new(), bags: Vec::new(), heals: Vec::new(), enemies, round_over: 0, round_running: 0, boss_killed: 0, round_result: 0, lobby_since: LOBBY_IDLE, majority_since: LOBBY_IDLE, enemy_work: 0, arena, events: Vec::new(), base };
        match cfg.terrain {
            TERRAIN_CAVES => {
                if let Some(b) = base.filter(|b| b.seed == seed && b.cfg == bytes && b.mat.len() == w * h && b.aux.len() == w * h) {
                    grid.mat.copy_from_slice(&b.mat);
                    grid.aux.copy_from_slice(&b.aux);
                    return Some(make(grid, b.pickups.clone(), b.enemies.clone(), b.arena, None));
                }
                let world = crate::gen::generate_world(&mut grid, seed, cfg.has_enemies());
                let (spots, arena, sites) = (world.spots, world.arena, world.sites);
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
                    let mut v: Vec<Enemy> = crate::gen::enemy_spots(&grid, seed, &at, arena.as_ref(), &sites)
                        .iter()
                        .enumerate()
                        .map(|(i, &(x, y, kind))| Enemy::new(i as u16, kind, i32::from(x) * POS_ONE + POS_ONE / 2, (i32::from(y) + 1) * POS_ONE))
                        .collect();
                    // F6: exactly one boss per Survival world, at the arena centre, hovering `BOSS_HOVER` cells above the floor.
                    // It gets the highest placed id (so ids stay sorted); `stepping_set` steps it first, so id order never starves it.
                    if let Some(a) = &arena {
                        // INT-2: which boss is a pure function of the seed (counter-based draw), roughly 50/50.
                        let mut boss = if boss_kind(seed) == ENEMY_COLOSSUS {
                            // The Sand Colossus stands on the arena floor; `last_hp` starts at its max.
                            let mut c = Enemy::new(v.len() as u16, ENEMY_COLOSSUS, a.cx * POS_ONE + POS_ONE / 2, a.floor_y * POS_ONE);
                            c.last_hp = c.hp;
                            c
                        } else {
                            Enemy::new(v.len() as u16, ENEMY_BOSS, a.cx * POS_ONE + POS_ONE / 2, (a.floor_y - BOSS_HOVER) * POS_ONE)
                        };
                        boss.phase = 1;
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
        // Review W F1 (D-176): `touch` reads `active` to decide `woken`, and inputs and entities write cells
        // before the region refresh below. `active` is scratch (a restored grid starts all true), so derive it from
        // entity state here first, or a client that just restored and one that ran on would disagree on this tick.
        self.refresh_active();
        let inputs = core::mem::take(&mut self.queue);
        self.paint_budget = MAX_PAINT_WORK_PER_TICK;
        for i in inputs {
            self.apply(i);
        }
        self.update_lobby();
        self.update_entities();
        self.refresh_active();
        self.grid.step_cells(self.seed, self.tick);
        if self.cfg.has_players() {
            let centres = core::mem::take(&mut self.grid.explosions);
            for &(cx, cy) in &centres {
                self.explode_at(cx as i32, cy as i32, GUNPOWDER_DAMAGE_RADIUS, 0, CAUSE_GUNPOWDER);
            }
            self.grid.explosions = centres;
            self.hazard_scan();
            self.enemy_hazard_scan();
            self.check_round_end();
        }
        // Hitboxes a falling island must not be written over: live players and enemies (cells, inclusive).
        let tick = self.tick;
        self.grid.fall_blockers.clear();
        for p in self.players.iter().filter(|p| p.alive(tick)) {
            self.grid.fall_blockers.push(p.hitbox_cells());
        }
        for e in &self.enemies {
            self.grid.fall_blockers.push(e.hitbox_cells());
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
        if self.cfg.round != 1 || self.round_over != 0 || self.in_lobby() {
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

    /// F6b (D-166): a one-life room is in its lobby until the countdown completes (`round_running`). In the lobby
    /// nothing hurts, enemies and pickups are inert and spells cannot be cast; players may still move.
    pub fn in_lobby(&self) -> bool {
        self.cfg.round == 1 && self.round_running == 0 && self.round_over == 0
    }

    /// Runs after the tick's inputs. Two countdowns, both pure state:
    /// - every active player ready (and at least one): `LOBBY_COUNTDOWN_TICKS` after the first such tick the round starts;
    /// - a strict majority ready (2 * ready > active): `LOBBY_MAJORITY_TICKS` after the first such tick the round starts
    ///   and everyone not ready becomes a spectator (dead, as for a late joiner). A solo player is a majority of one, so
    ///   the short rule always fires first for a room of one.
    ///
    /// Un-ready, Join and a real Leave reset both (the count of active players changed or a flag flipped); losing the
    /// majority resets the long one. At the start every living player is put back at a spawn point (S2: no pre-positioning).
    fn update_lobby(&mut self) {
        if !self.in_lobby() {
            return;
        }
        let (mut active, mut ready) = (0u32, 0u32);
        for p in self.players.iter().filter(|p| p.active) {
            active += 1;
            ready += u32::from(p.ready);
        }
        if active == 0 || 2 * ready <= active {
            self.lobby_since = LOBBY_IDLE;
            self.majority_since = LOBBY_IDLE;
            return;
        }
        if self.majority_since == LOBBY_IDLE {
            self.majority_since = self.tick;
        }
        if ready == active {
            if self.lobby_since == LOBBY_IDLE {
                self.lobby_since = self.tick;
            }
        } else {
            self.lobby_since = LOBBY_IDLE;
        }
        let short = self.lobby_since != LOBBY_IDLE && self.tick.wrapping_sub(self.lobby_since) >= LOBBY_COUNTDOWN_TICKS;
        let long = self.tick.wrapping_sub(self.majority_since) >= LOBBY_MAJORITY_TICKS;
        if short || long {
            self.start_round(active);
        }
    }

    fn start_round(&mut self, active: u32) {
        self.round_running = 1;
        self.lobby_since = LOBBY_IDLE;
        self.majority_since = LOBBY_IDLE;
        for k in 0..self.players.len() {
            let (id, active_p, ready) = (self.players[k].id, self.players[k].active, self.players[k].ready);
            if active_p && ready == 0 {
                // Not ready at the long start: a spectator, exactly like a late joiner.
                self.players[k].health = 0;
                self.players[k].dead_until = u32::MAX;
            } else if self.players[k].health > 0 {
                let (x, y) = self.spawn_point(id);
                let p = &mut self.players[k];
                p.life = p.life.wrapping_add(1);
                p.x = x;
                p.y = y;
            }
        }
        self.events.push(Event { kind: EV_ROUND_START, player: 0, a: active as i32, b: 0, c: 0 });
    }

    pub fn round_tail(&self) -> [u8; ROUND_TAIL_BYTES] {
        let (l, m) = (self.lobby_since.to_le_bytes(), self.majority_since.to_le_bytes());
        [self.round_over, self.round_running, self.boss_killed, self.round_result, l[0], l[1], l[2], l[3], m[0], m[1], m[2], m[3]]
    }

    /// D-158: the boss's death wins the round. `reap_enemies` sets the hashed `boss_killed` field when a boss
    /// dies. A restored snapshot,
    /// including one taken after the win, therefore says the same thing. A win and the last player's death on the same
    /// tick count as a win: `check_round_end` lets `won` take precedence over `lost`.
    fn round_won(&self) -> bool {
        self.boss_killed != 0
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
            Input::Join { .. } | Input::Leave { .. } | Input::Pos { .. } | Input::Cast { .. } | Input::Ready { .. } if !self.cfg.has_players() => {}
            Input::Join { player } => self.join(player),
            Input::Leave { player } => {
                if let Ok(k) = self.player_index(player) {
                    // Only a real active -> inactive change resets the countdowns (a spurious Leave does nothing).
                    if self.players[k].active {
                        self.players[k].active = false;
                        self.players[k].ready = 0;
                        self.lobby_since = LOBBY_IDLE;
                        self.majority_since = LOBBY_IDLE;
                    }
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
            Input::Cast { player, spell, angle, cast_seq } => {
                if !self.in_lobby() {
                    self.cast(player, spell, angle, cast_seq)
                }
            }
            Input::Ready { player, ready } => {
                if self.in_lobby() {
                    if let Ok(k) = self.player_index(player) {
                        let p = &mut self.players[k];
                        if p.active {
                            p.ready = ready;
                        }
                    }
                }
            }
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
                // D-166: in a one-life round, a player whose first Join comes after the lobby countdown completed or the round ended joins already dead and spectates.
                if self.cfg.round == 1 && !self.in_lobby() {
                    p.health = 0;
                    p.dead_until = u32::MAX;
                }
                self.players.insert(at, p);
                at
            }
        };
        let p = &mut self.players[k];
        p.active = true;
        // F6b: any join resets readiness and the countdown (a rejoiner must ready up again).
        p.ready = 0;
        self.lobby_since = LOBBY_IDLE;
        self.majority_since = LOBBY_IDLE;
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
            let Some(ground) = (0..h).find(|&y| matches!(g.mat[(y * w + col) as usize], DIRT | ROCK | SAND | PEBBLES | BEDROCK)) else {
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
        self.update_heals();
        if self.pickups.is_empty() || self.in_lobby() {
            return;
        }
        for p in self.players.iter_mut().filter(|p| p.alive(tick)) {
            let (x0, y0, x1, y1) = p.hitbox_cells();
            // Pickups reach a little below the feet (the user, 5 Nov): on narrow footing the hitbox sat just above.
            let y1 = y1 + PICKUP_REACH_BELOW;
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
        // Truncate from (x0, y0) along the same line: the interpolation still uses the full `n`, so direction is kept.
        // Review H2: every stamp is charged its disc's bounding box against the tick's budget; once one does not fit,
        // painting is over for this tick (the budget stays short, so later Paint inputs this tick draw nothing either).
        let cost = i64::from(2 * r + 1) * i64::from(2 * r + 1);
        for k in 0..=paint_stamps(n) {
            if self.paint_budget < cost {
                self.paint_budget = 0;
                return;
            }
            self.paint_budget -= cost;
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
                // Seeds sprinkle: the draw depends on the cell and the tick, not the stamp, so overlapping stamps
                // of one stroke agree and a drag never thickens the sprinkle.
                if mat == SEED && !rng(self.seed, self.tick, x as u32, y as u32, SALT_PAINT_SEED).is_multiple_of(PAINT_SEED_ONE_IN) {
                    continue;
                }
                if is_structural(mat) {
                    // A hard stroke records no crumble seeds: painted rock may float.
                    self.grid.set_unseeded(i, mat, 0);
                } else {
                    self.grid.set(i, mat, 0);
                }
            }
        }
    }

    /// Canonical entity bytes (plan 6.10): players by id, then pickups. In the state hash and snapshots.
    pub fn entity_bytes(&self) -> Vec<u8> {
        if !self.cfg.has_players() {
            return Vec::new(); // the sandbox has no entities, and its hashes stay what they were
        }
        entities::encode(&self.players, &self.pickups, &self.projectiles, &self.bags, &self.enemies, &self.heals, self.round_tail())
    }

    pub fn state_hash(&mut self) -> u64 {
        let e = self.entity_bytes();
        hash::state_hash(&mut self.grid, self.tick, &self.cfg.encode(), &e)
    }
}

/// The boss a Survival world of this seed gets: the Sand Colossus on an odd draw, the Deep Mage on an even one.
pub fn boss_kind(seed: u64) -> u8 {
    if rng(seed, 0, 0, 0, crate::rng::SALT_BOSS_KIND) & 1 == 1 { ENEMY_COLOSSUS } else { ENEMY_BOSS }
}

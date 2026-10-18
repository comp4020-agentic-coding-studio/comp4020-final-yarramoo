//! Casting, projectiles and impacts (plan 6.6, 6.7). Part of the simulation: integers only, bounded work,
//! and everything reachable from a `Cast` input is capped (projectile counts, sub-steps, burst sizes).

use crate::entities::*;
use crate::materials::*;
use crate::rng::{rng, SALT_BURST};
use crate::sim::Sim;
use crate::trig::{dir, TRIG_ONE};
use crate::tuning::*;

pub const PUSH: u8 = 0;
pub const BLAST: u8 = 1;
pub const WATER_SPELL: u8 = 2;
pub const ROSE: u8 = 3;

/// A live player's hitbox for this tick: `(id, x0, y0, x1, y1)` in cells, inclusive.
type Box5 = (u32, i32, i32, i32, i32);

/// Floor square root, integer Newton. No floats (invariant 3).
pub fn isqrt(n: u64) -> u32 {
    if n < 2 {
        return n as u32;
    }
    let mut x = n;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x as u32
}

impl Player {
    /// Alive means able to act and be hit. Nothing can kill a player before M5, but the rule is already
    /// the one M5 needs (plan 6.8): health above zero and the respawn timer elapsed.
    pub fn alive(&self, tick: u32) -> bool {
        self.active && self.health > 0 && tick >= self.dead_until
    }
}

impl Sim {
    fn reject(&mut self, player: u32, spell: u8, reason: i32, seq: u16) {
        self.events.push(Event { kind: EV_CAST_REJECTED, player, a: i32::from(spell), b: reason, c: i32::from(seq) });
    }

    /// A Cast input. Spawns a bolt (or, for Blast, resolves the cone now) at the caster's official position.
    pub(crate) fn cast(&mut self, player: u32, spell: u8, angle: u16, seq: u16) {
        let Ok(k) = self.players.binary_search_by_key(&player, |p| p.id) else { return };
        let tick = self.tick;
        let s = usize::from(spell);
        if s >= NUM_SPELLS || !SPELL_ENABLED[s] {
            return self.reject(player, spell, REJECT_SPELL, seq);
        }
        let p = &self.players[k];
        if !p.active {
            return;
        }
        let (px, py) = (p.x, p.y - CHEST * POS_ONE);
        let reason = if !p.alive(tick) {
            REJECT_DEAD
        } else if p.charges[s] == 0 {
            REJECT_CHARGES
        } else if tick < p.cooldown_until[s] {
            REJECT_COOLDOWN
        } else if spell != BLAST
            && (self.projectiles.len() >= MAX_PROJECTILES
                || self.projectiles.iter().filter(|q| q.owner == player).count() >= MAX_PROJECTILES_PER_PLAYER)
        {
            REJECT_FULL
        } else {
            0
        };
        if reason != 0 {
            return self.reject(player, spell, reason, seq);
        }
        let p = &mut self.players[k];
        if p.charges[s] != INFINITE {
            p.charges[s] -= 1;
        }
        p.cooldown_until[s] = tick.wrapping_add(COOLDOWN[s]);
        self.events.push(Event { kind: EV_CAST, player, a: i32::from(spell), b: i32::from(angle), c: i32::from(seq) });
        if spell == BLAST {
            return self.blast(player, px, py, angle);
        }
        let (c, sn) = dir(angle);
        let v = SPEED[s];
        self.projectiles.push(Projectile {
            owner: player,
            spell,
            cast_seq: seq,
            // 1/16 cell to 1/256 cell
            x: px << (PROJ_SHIFT - POS_SHIFT),
            y: py << (PROJ_SHIFT - POS_SHIFT),
            vx: c * v / TRIG_ONE,
            vy: sn * v / TRIG_ONE,
            age: 0,
        });
    }

    /// Blast: a cone of `BLAST_RADIUS_CELLS` and 45 degrees either side of the aim, no projectile.
    /// Every other live player whose chest is inside gets `Knock` and the caster is their last hitter.
    fn blast(&mut self, caster: u32, cx: i32, cy: i32, angle: u16) {
        let (c, sn) = dir(angle);
        let reach = i64::from(BLAST_RADIUS_CELLS * POS_ONE);
        let tick = self.tick;
        for i in 0..self.players.len() {
            let t = &self.players[i];
            if t.id == caster || !t.alive(tick) {
                continue;
            }
            let (dx, dy) = (i64::from(t.x - cx), i64::from(t.y - CHEST * POS_ONE - cy));
            let d2 = dx * dx + dy * dy;
            if d2 > reach * reach {
                continue;
            }
            let dot = dx * i64::from(c) + dy * i64::from(sn);
            let one = i64::from(TRIG_ONE);
            // Inside the cone: in front, and cos(angle between) >= cos 45 degrees.
            if d2 > 0 && (dot <= 0 || 2 * dot * dot < d2 * one * one) {
                continue;
            }
            let id = t.id;
            self.hit_player(id, caster, c * KNOCK_BLAST / TRIG_ONE, sn * KNOCK_BLAST / TRIG_ONE);
        }
    }

    fn hit_player(&mut self, victim: u32, attacker: u32, vx: i32, vy: i32) {
        let tick = self.tick;
        if let Ok(k) = self.players.binary_search_by_key(&victim, |p| p.id) {
            self.players[k].last_hit_by = attacker;
            self.players[k].last_hit_tick = tick;
        }
        self.events.push(Event { kind: EV_KNOCK, player: victim, a: vx, b: vy, c: attacker as i32 });
    }

    /// Plan 6.2 step 2, projectiles in spawn order. Removal keeps the order of the survivors.
    pub(crate) fn update_projectiles(&mut self) {
        if self.projectiles.is_empty() {
            return;
        }
        let tick = self.tick;
        let boxes: Vec<Box5> = self
            .players
            .iter()
            .filter(|p| p.alive(tick))
            .map(|p| {
                let (x0, y0, x1, y1) = p.hitbox_cells();
                (p.id, x0, y0, x1, y1)
            })
            .collect();
        let mut qs = core::mem::take(&mut self.projectiles);
        let mut gone = Vec::with_capacity(qs.len());
        for q in qs.iter_mut() {
            gone.push(!self.step_projectile(q, &boxes));
        }
        let mut i = 0;
        qs.retain(|_| {
            i += 1;
            !gone[i - 1]
        });
        self.projectiles = qs;
    }

    /// One tick of one bolt: gravity, then at most `MAX_SUBSTEPS` integer sub-steps of at most one cell.
    /// Returns false when the bolt is gone.
    fn step_projectile(&mut self, q: &mut Projectile, boxes: &[Box5]) -> bool {
        q.age += 1;
        if q.age > PROJ_MAX_AGE {
            return false;
        }
        let s = usize::from(q.spell);
        q.vy = (q.vy + GRAVITY_Q8[s]).clamp(-PROJ_MAX_SPEED, PROJ_MAX_SPEED);
        q.vx = q.vx.clamp(-PROJ_MAX_SPEED, PROJ_MAX_SPEED);
        let n = ((q.vx.abs().max(q.vy.abs()) + PROJ_ONE - 1) / PROJ_ONE).clamp(1, MAX_SUBSTEPS);
        let (x0, y0) = (q.x, q.y);
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        let mut free = (x0 >> PROJ_SHIFT, y0 >> PROJ_SHIFT);
        for k in 1..=n {
            let (cx, cy) = ((x0 + q.vx * k / n) >> PROJ_SHIFT, (y0 + q.vy * k / n) >> PROJ_SHIFT);
            if cx < 0 || cy < 0 || cx >= w || cy >= h {
                return false;
            }
            for &(id, bx0, by0, bx1, by1) in boxes {
                if (id == q.owner && q.age <= OWNER_GRACE) || cx < bx0 || cx > bx1 || cy < by0 || cy > by1 {
                    continue;
                }
                self.impact(q, (cx, cy), Some(id));
                return false;
            }
            let m = self.grid.mat[(cy * w + cx) as usize];
            if m != EMPTY && !is_gas(m) {
                self.impact(q, free, None);
                return false;
            }
            free = (cx, cy);
        }
        q.x = x0 + q.vx;
        q.y = y0 + q.vy;
        true
    }

    fn impact(&mut self, q: &Projectile, at: (i32, i32), hit: Option<u32>) {
        self.events.push(Event { kind: EV_IMPACT, player: q.owner, a: at.0, b: at.1, c: i32::from(q.spell) });
        match q.spell {
            PUSH => {
                if let Some(v) = hit {
                    self.hit_player(v, q.owner, q.vx * KNOCK_PUSH / SPEED[PUSH as usize], q.vy * KNOCK_PUSH / SPEED[PUSH as usize]);
                }
            }
            WATER_SPELL => self.burst_water(at),
            ROSE => self.burst_seeds(at),
            _ => {}
        }
    }

    /// Fill up to `WATER_BURST_CELLS` Empty cells of the disc around `at`, the impact row and the rows above it
    /// first (the cells below are usually the floor the bolt hit). Never overwrites anything: a burst into a
    /// full cave does little, by design. At most 13 x 13 cells are looked at.
    fn burst_water(&mut self, at: (i32, i32)) {
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        let mut left = WATER_BURST_CELLS;
        for k in 0..13i32 {
            let dy = if k <= 6 { -k } else { k - 6 };
            for dx in -6..=6i32 {
                let (x, y) = (at.0 + dx, at.1 + dy);
                if left == 0 || dx * dx + dy * dy > WATER_BURST_R2 || x < 0 || y < 0 || x >= w || y >= h {
                    continue;
                }
                let i = (y * w + x) as usize;
                if self.grid.mat[i] == EMPTY {
                    self.grid.set(i, WATER, 0);
                    left -= 1;
                }
            }
        }
    }

    /// Scatter `SEED_BURST_CELLS` Seed cells within `SEED_BURST_R` of `at` (Empty cells only).
    fn burst_seeds(&mut self, at: (i32, i32)) {
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        let span = 2 * SEED_BURST_R + 1;
        for k in 0..SEED_BURST_CELLS {
            let r = rng(self.seed, self.tick, at.0 as u32, ((at.1 as u32) << 4) | k, SALT_BURST);
            let dx = (r % span) as i32 - SEED_BURST_R as i32;
            let dy = ((r / span) % span) as i32 - SEED_BURST_R as i32;
            let (x, y) = (at.0 + dx, at.1 + dy);
            if x < 0 || y < 0 || x >= w || y >= h {
                continue;
            }
            let i = (y * w + x) as usize;
            if self.grid.mat[i] == EMPTY {
                self.grid.set(i, SEED, 0);
            }
        }
    }

    /// Take `amount` health from the player at `victim_index`, saturating at 0. Only an alive player takes
    /// damage (a corpse takes none). At 0 the player dies: `dead_until`, then `EV_DEATH` with the killer
    /// (the last other hitter within `KILL_CREDIT_TICKS`, else 0) and `cause`.
    pub(crate) fn apply_damage(&mut self, victim_index: usize, amount: u8, cause: u8) {
        let tick = self.tick;
        let p = &mut self.players[victim_index];
        if !p.alive(tick) || amount == 0 {
            return;
        }
        p.health = p.health.saturating_sub(amount);
        if p.health > 0 {
            return;
        }
        p.dead_until = tick.wrapping_add(DEATH_TICKS);
        let credited = p.last_hit_by != 0 && p.last_hit_by != p.id && tick.wrapping_sub(p.last_hit_tick) <= KILL_CREDIT_TICKS;
        let killer = if credited { p.last_hit_by } else { 0 };
        // `c` is reserved: slice 3 sets it to 1 when the death dropped a bag.
        self.events.push(Event { kind: EV_DEATH, player: p.id, a: killer as i32, b: i32::from(cause), c: 0 });
    }

    /// An explosion of radius `r` cells at (`cx`, `cy`): `EV_EXPLODE` once, then for each alive player in id
    /// order, linear damage (`EXPLOSION_DAMAGE_MAX` at the centre, 0 at `r`) and knockback within 1.5 r.
    /// A non-zero `owner` becomes the victim's last hitter unless the victim is the owner (gunpowder passes 0,
    /// and credits nobody: invariant 11 forbids per-cell ownership). The grid carving is the caller's job.
    pub fn explode_at(&mut self, cx: i32, cy: i32, r: i32, owner: u32, cause: u8) {
        let tick = self.tick;
        self.events.push(Event { kind: EV_EXPLODE, player: owner, a: cx, b: cy, c: r });
        let kr = r * 3 / 2;
        if r <= 0 {
            return;
        }
        for i in 0..self.players.len() {
            let t = &self.players[i];
            if !t.alive(tick) {
                continue;
            }
            // Distances in 1/16 cell, to the chest.
            let (dx, dy) = (i64::from(t.x - cx * POS_ONE - POS_ONE / 2), i64::from(t.y - CHEST * POS_ONE - cy * POS_ONE - POS_ONE / 2));
            let dist = isqrt((dx * dx + dy * dy) as u64) as i64;
            let d = (dist >> POS_SHIFT) as i32;
            if d >= kr {
                continue;
            }
            let id = t.id;
            if owner != 0 && id != owner {
                self.players[i].last_hit_by = owner;
                self.players[i].last_hit_tick = tick;
            }
            if d < r {
                self.apply_damage(i, (EXPLOSION_DAMAGE_MAX * (r - d) / r) as u8, cause);
            }
            let mag = i64::from(KNOCK_EXPLOSION * (kr - d) / kr);
            let (vx, vy) = if dist == 0 { (0, -mag) } else { (mag * dx / dist, mag * dy / dist) };
            self.events.push(Event { kind: EV_KNOCK, player: id, a: vx as i32, b: vy as i32, c: owner as i32 });
        }
    }

    /// Lava and fire contact for every active, alive player, in id order. Lava costs 1 HP on even ticks,
    /// fire 1 HP when `(tick + id) % 6 == 0`; lava wins if both touch. Reads only the player's own hitbox,
    /// which lies inside the awake region of an active player, so chunk sleeping cannot change the result.
    pub(crate) fn hazard_scan(&mut self) {
        let tick = self.tick;
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        for i in 0..self.players.len() {
            let p = &self.players[i];
            if !p.alive(tick) {
                continue;
            }
            let (x0, y0, x1, y1) = p.hitbox_cells();
            let (mut lava, mut fire) = (false, false);
            for y in y0.max(0)..=y1.min(h - 1) {
                for x in x0.max(0)..=x1.min(w - 1) {
                    match self.grid.mat[(y * w + x) as usize] {
                        LAVA => lava = true,
                        FIRE => fire = true,
                        _ => {}
                    }
                }
            }
            let id = p.id;
            if lava {
                if tick.is_multiple_of(2) {
                    self.apply_damage(i, 1, CAUSE_LAVA);
                }
            } else if fire && tick.wrapping_add(id).is_multiple_of(6) {
                self.apply_damage(i, 1, CAUSE_FIRE);
            }
        }
    }

    /// Put a player back at the spawn point with a new `life` (plan 6.8). Called by `update_entities` at
    /// `dead_until`. Public so tests can drive the respawn path.
    pub fn respawn_player(&mut self, id: u32) {
        let Ok(k) = self.players.binary_search_by_key(&id, |p| p.id) else { return };
        let (x, y) = self.spawn_point(id);
        let p = &mut self.players[k];
        p.life = p.life.wrapping_add(1);
        p.x = x;
        p.y = y;
        p.health = HEALTH_MAX;
        p.dead_until = 0;
        let ev = Event { kind: EV_RESPAWN, player: id, a: x, b: y, c: i32::from(p.life) };
        self.events.push(ev);
    }
}

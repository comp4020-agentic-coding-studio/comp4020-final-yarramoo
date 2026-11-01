//! Enemies (F4, docs/research/enemies-design.md sections 2-4). Integer-only, bounded, and a pure function of
//! hashed state: the stepping set comes from `players` (never from `grid.awake`), so chunk sleeping is invisible.
//!
//! Stepping rule: an enemy steps on a tick only if it lies inside an `ENEMY_ACTIVE_W x ENEMY_ACTIVE_H` rectangle
//! around an active, alive player; otherwise it is frozen (no movement, timers, AI or contact damage). At most
//! `MAX_ENEMIES_STEPPED` step per tick, lowest ids first. Enemies step in id order, after `update_projectiles`.

use crate::entities::*;
use crate::materials::*;
use crate::rng::{rng, SALT_BOSS_RING, SALT_BOSS_SUMMON, SALT_ENEMY_HOP, SALT_ENEMY_IDLE};
use crate::sim::Sim;
use crate::spells::{isqrt, BOMB, FIRE_BOLT};
use crate::tuning::*;

/// An alive, active player as the AI sees it: `(id, x, y)` in 1/16 cell.
pub type Target = (u32, i32, i32);

impl Sim {
    /// True when an enemy at feet (`x`, `y`) with a `w` x `h` body overlaps a solid cell or the world edge.
    /// Adds the cells it looked at to `enemy_work`.
    fn enemy_blocked(&mut self, x: i32, y: i32, w: i32, h: i32) -> bool {
        let half = w * POS_ONE / 2;
        let (x0, y0, x1, y1) = ((x - half) >> POS_SHIFT, (y - h * POS_ONE) >> POS_SHIFT, (x + half - 1) >> POS_SHIFT, (y - 1) >> POS_SHIFT);
        let (gw, gh) = (self.grid.w as i32, self.grid.h as i32);
        if x0 < 0 || y0 < 0 || x1 >= gw || y1 >= gh {
            return true;
        }
        self.enemy_work += ((x1 - x0 + 1) * (y1 - y0 + 1)) as u32;
        for cy in y0..=y1 {
            for cx in x0..=x1 {
                if blocks_enemy(self.grid.mat[(cy * gw + cx) as usize]) {
                    return true;
                }
            }
        }
        false
    }

    /// True when no solid cell lies on the straight line of cells from `a` to `b` (both in cells), walked at one
    /// cell per step for at most `LOS_MAX_STEPS` steps (a longer line counts as blocked). The first solid cell stops it.
    /// Integer division truncates toward zero, the same on every platform. Adds the steps to `enemy_work`.
    pub fn line_clear(&mut self, a: (i32, i32), b: (i32, i32)) -> bool {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let n = dx.abs().max(dy.abs());
        if n > LOS_MAX_STEPS {
            return false;
        }
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        for k in 1..n {
            let (x, y) = (a.0 + dx * k / n, a.1 + dy * k / n);
            if x < 0 || y < 0 || x >= w || y >= h || blocks_enemy(self.grid.mat[(y * w + x) as usize]) {
                return false;
            }
        }
        self.enemy_work += n.max(0) as u32;
        true
    }

    /// The imp: a flier (no gravity). Hunts the nearest player within `IMP_AGGRO_CELLS`: closes in beyond
    /// `IMP_FAR_CELLS`, backs off inside `IMP_NEAR_CELLS`, otherwise bobs; velocity changes by 1 per tick toward the
    /// wanted one, so knockback decays instead of vanishing. Fires a Fire bolt every `IMP_FIRE_TICKS` at a target
    /// within `IMP_FIRE_RANGE` with a clear line, the line tested only when `(tick + id) % IMP_LOS_EVERY == 0`
    /// (one walk of at most `LOS_MAX_STEPS` cells per imp per 15 ticks). The aim is raised to cancel the bolt's drop.
    fn imp_ai(&mut self, e: &mut Enemy, st: EnemyStats, targets: &[Target]) {
        let tick = self.tick;
        let mut best: Option<(i64, i32, i32)> = None;
        for &(_, px, py) in targets {
            let (dx, dy) = (px - e.x, py - CHEST * POS_ONE - (e.y - st.h * POS_ONE / 2));
            let d2 = i64::from(dx) * i64::from(dx) + i64::from(dy) * i64::from(dy);
            if best.is_none_or(|(b, _, _)| d2 < b) {
                best = Some((d2, dx, dy));
            }
        }
        let bob = if (tick / 32).is_multiple_of(2) { 1 } else { -1 };
        let aggro = i64::from(IMP_AGGRO_CELLS * POS_ONE);
        let (mut wx, mut wy) = (0, bob);
        e.state &= !1;
        if let Some((d2, dx, dy)) = best.filter(|&(d2, _, _)| d2 <= aggro * aggro) {
            e.state |= 1;
            let dist = i64::from(isqrt(d2 as u64));
            let sx = dx.signum() * IMP_SPEED;
            let sy = dy.signum() * IMP_SPEED;
            // Toward the target on each axis that is more than half the other, away when inside the near band.
            let sign = if dist > i64::from(IMP_FAR_CELLS * POS_ONE) { 1 } else if dist < i64::from(IMP_NEAR_CELLS * POS_ONE) { -1 } else { 0 };
            if sign != 0 {
                if dx.abs() * 2 > dy.abs() {
                    wx = sign * sx;
                }
                if dy.abs() * 2 > dx.abs() {
                    wy = sign * sy;
                }
            }
            if dx != 0 {
                e.facing = u8::from(dx > 0);
            }
            if tick >= e.cooldown_until && tick.wrapping_add(u32::from(e.id)).is_multiple_of(IMP_LOS_EVERY) && dist <= i64::from(IMP_FIRE_RANGE * POS_ONE) {
                let from = (e.x, e.y - st.h * POS_ONE / 2);
                let to = (from.0 + dx, from.1 + dy);
                if self.line_clear((from.0 >> POS_SHIFT, from.1 >> POS_SHIFT), (to.0 >> POS_SHIFT, to.1 >> POS_SHIFT)) {
                    let cells = (dist >> POS_SHIFT) as i32;
                    // Drop of the bolt over the flight, in cells: d^2 / 1568 (g 4/256 per tick^2, speed 3.5 cells per tick).
                    let lift = cells * cells / 1568 * POS_ONE;
                    if self.enemy_fire((e.kind, e.id), FIRE_BOLT, from, (dx, dy - lift)) {
                        e.cooldown_until = tick.wrapping_add(IMP_FIRE_TICKS);
                    }
                }
            }
        }
        e.vx += (wx - i32::from(e.vx)).signum() as i16;
        e.vy += (wy - i32::from(e.vy)).signum() as i16;
    }

    /// Phase 2+: on ticks where `(tick + id) % BOSS_SUMMON_TICKS == 150`, up to `BOSS_SUMMON_PER_CAST` imps appear in
    /// rng-chosen EMPTY 5 x 4 pockets inside the arena (`BOSS_SUMMON_TRIES` tries each, 20 cells read per try), while
    /// fewer than `BOSS_SUMMONS_ALIVE` summoned imps live, the room has space, and the fight total is under
    /// `BOSS_SUMMONS_TOTAL`. Ids: `boss id + 1 + summons so far` (the counter is the boss's `hop_until`, which only
    /// grows), so they are unique forever, above every placed id, and appended in order.
    fn boss_summon(&mut self, e: &mut Enemy, id32: u32) {
        let Some(a) = self.arena else { return };
        if id32 % BOSS_SUMMON_TICKS != 150 {
            return;
        }
        let w = self.grid.w as i32;
        for n in 0..BOSS_SUMMON_PER_CAST as u32 {
            let alive = self.enemies.iter().filter(|o| o.kind == ENEMY_IMP && o.id > e.id).count();
            if alive >= BOSS_SUMMONS_ALIVE || self.enemies.len() >= MAX_ENEMIES || e.hop_until >= BOSS_SUMMONS_TOTAL {
                return;
            }
            let hw = a.floor_half_width();
            for t in 0..BOSS_SUMMON_TRIES {
                let r = rng(self.seed, self.tick, u32::from(e.id), n * 16 + t, SALT_BOSS_SUMMON);
                let x = a.cx - hw + (r % (2 * hw as u32 + 1)) as i32;
                let y = a.cy - a.ry / 2 + ((r >> 16) % (a.ry as u32 / 2)) as i32;
                self.enemy_work += 20;
                let free = (x - 2..=x + 2).all(|bx| (y - 4..y).all(|by| a.contains(bx, by, -2) && self.grid.mat[(by * w + bx) as usize] == EMPTY));
                if free {
                    let id = e.id + 1 + e.hop_until as u16;
                    e.hop_until += 1;
                    self.enemies.push(Enemy::new(id, ENEMY_IMP, x * POS_ONE + POS_ONE / 2, y * POS_ONE));
                    break;
                }
            }
        }
    }

    /// Phase 3: on ticks where `(tick + id) % BOSS_RING_TICKS == 60`, `BOSS_RING_CELLS` LAVA cells in an arc on the
    /// floor (the row above it, bowed up one row at the ends, so it reads as an arc), centred on an rng offset.
    /// Only EMPTY cells change, written with `Grid::set`: at most 24 writes.
    fn boss_ring(&mut self, e: &Enemy) {
        let Some(a) = self.arena else { return };
        let w = self.grid.w as i32;
        let hw = a.floor_half_width();
        let span = (2 * hw - BOSS_RING_CELLS).max(1) as u32;
        let x0 = a.cx - hw + (rng(self.seed, self.tick, u32::from(e.id), 0, SALT_BOSS_RING) % span) as i32;
        for k in 0..BOSS_RING_CELLS {
            let bow = i32::from(!(3..BOSS_RING_CELLS - 3).contains(&k));
            let (x, y) = (x0 + k, a.floor_y - 1 - bow);
            let i = (y * w + x) as usize;
            if a.contains(x, y, 0) && self.grid.mat[i] == EMPTY {
                self.grid.set(i, LAVA, 0);
            }
        }
        self.enemy_work += BOSS_RING_CELLS as u32;
    }

    /// The Deep Mage (F6): a flier like the imp. Hovers, drifts toward the nearest player (closing beyond
    /// `BOSS_CLOSE_CELLS`, bobbing otherwise), is leashed to the arena ellipse, and fires a Fire bolt at the nearest
    /// player in line of sight every `BOSS_FIRE_TICKS` ticks (stateless cadence: `(tick + id) % period == 0`).
    /// Velocity eases 1 per tick toward the wanted one, like the imp. Contact shove is the shared `enemy_contact`.
    fn boss_ai(&mut self, e: &mut Enemy, st: EnemyStats, targets: &[Target]) {
        let tick = self.tick;
        let mid = st.h * POS_ONE / 2;
        let mut best: Option<(i64, i32, i32)> = None;
        for &(_, px, py) in targets {
            let (dx, dy) = (px - e.x, py - CHEST * POS_ONE - (e.y - mid));
            let d2 = i64::from(dx) * i64::from(dx) + i64::from(dy) * i64::from(dy);
            if best.is_none_or(|(b, _, _)| d2 < b) {
                best = Some((d2, dx, dy));
            }
        }
        // The phase follows hp (thirds of the maximum) and only ever rises: each rise emits `EV_ENEMY_PHASE`.
        let max = u32::from(st.hp);
        let want: u8 = if u32::from(e.hp) * 3 > max * 2 { 1 } else if u32::from(e.hp) * 3 > max { 2 } else { 3 };
        if want > e.state >> 2 {
            e.state = (e.state & 0b11) | (want << 2);
            self.events.push(Event { kind: EV_ENEMY_PHASE, player: 0, a: i32::from(e.id), b: i32::from(want), c: 0 });
        }
        let phase = e.state >> 2;
        let bob = if (tick / 32).is_multiple_of(2) { 1 } else { -1 };
        let speed = if phase >= 3 { BOSS_SPEED * 3 / 2 } else { BOSS_SPEED };
        let (mut wx, mut wy) = (0, bob);
        e.state &= !1;
        let id32 = tick.wrapping_add(u32::from(e.id));
        if phase >= 2 {
            self.boss_summon(e, id32);
        }
        if phase >= 3 && id32 % BOSS_RING_TICKS == 60 {
            self.boss_ring(e);
        }
        if let Some((d2, dx, dy)) = best.filter(|&(d2, _, _)| d2 <= i64::from(BOSS_AGGRO_CELLS * POS_ONE).pow(2)) {
            e.state |= 1;
            let dist = i64::from(isqrt(d2 as u64));
            if dist > i64::from(BOSS_CLOSE_CELLS * POS_ONE) {
                if dx.abs() * 2 > dy.abs() {
                    wx = dx.signum() * speed;
                }
                if dy.abs() * 2 > dx.abs() {
                    wy = dy.signum() * speed;
                }
            }
            if dx != 0 {
                e.facing = u8::from(dx > 0);
            }
            let period = if phase >= 3 { BOSS_FAN_TICKS } else { BOSS_FIRE_TICKS };
            let in_range = dist <= i64::from(BOSS_FIRE_RANGE * POS_ONE);
            let from = (e.x, e.y - mid);
            if in_range && (id32.is_multiple_of(period) || (phase == 2 && id32 % BOSS_BOMB_TICKS == 30)) {
                let to = (from.0 + dx, from.1 + dy);
                if self.line_clear((from.0 >> POS_SHIFT, from.1 >> POS_SHIFT), (to.0 >> POS_SHIFT, to.1 >> POS_SHIFT)) {
                    let cells = (dist >> POS_SHIFT) as i32;
                    let lift = cells * cells / 1568 * POS_ONE;
                    if id32.is_multiple_of(period) {
                        self.enemy_fire((e.kind, e.id), FIRE_BOLT, from, (dx, dy - lift));
                        if phase >= 3 {
                            // The fan: the aim turned a quarter-radian either way (perpendicular / `BOSS_FAN_SLOPE`).
                            for sgn in [-1, 1] {
                                self.enemy_fire((e.kind, e.id), FIRE_BOLT, from, (dx - sgn * dy / BOSS_FAN_SLOPE, dy - lift + sgn * dx / BOSS_FAN_SLOPE));
                            }
                        }
                    }
                }
            }
            if in_range && phase >= 2 && id32 % BOSS_BOMB_TICKS == 30 {
                // A lob: aimed above the player so the arc lands near them (gravity 20/256 per tick, speed 2.5 cells per tick).
                let cells = (dist >> POS_SHIFT) as i32;
                let lift = cells * cells / 620 * POS_ONE + cells * POS_ONE / 6;
                self.enemy_fire((e.kind, e.id), BOMB, from, (dx, dy - lift));
            }
        }
        // The leash: toward the arena centre when the next step would leave the ellipse (grown by a negative margin).
        if let Some(a) = self.arena {
            let (nx, ny) = ((e.x + i32::from(e.vx) * 4) >> POS_SHIFT, (e.y - mid + i32::from(e.vy) * 4) >> POS_SHIFT);
            if !a.contains(nx, ny, -BOSS_LEASH_MARGIN) {
                wx = (a.cx * POS_ONE - e.x).signum() * speed;
                wy = ((a.cy * POS_ONE) - (e.y - mid)).signum() * speed;
                e.vx = (i32::from(e.vx) + wx.signum() * 2).clamp(-ENEMY_MAX_SPEED, ENEMY_MAX_SPEED) as i16;
                e.vy = (i32::from(e.vy) + wy.signum() * 2).clamp(-ENEMY_MAX_SPEED, ENEMY_MAX_SPEED) as i16;
            }
        }
        e.vx += (wx - i32::from(e.vx)).signum() as i16;
        e.vy += (wy - i32::from(e.vy)).signum() as i16;
    }

    /// The worm. It is meant to be inside rock, so it has no body collision, no gravity and no embedded rescue.
    /// Dormant (state bit 0 clear): it only wakes when an alive player is within `WORM_WAKE_CELLS`. Awake: it moves
    /// toward the nearest player within `WORM_HUNT_CELLS` at `WORM_SPEED_ROCK` per axis while its centre cell is solid
    /// and `WORM_SPEED_OPEN` otherwise (an axis moves when the offset on it is more than half the other), never
    /// into Bedrock or within 4 cells of the world edge, and digs the radius-3 disc around its centre every tick
    /// (`Grid::dig`: at most 49 cells, solids and plants only; liquids stay, so a pool it reaches simply flows in).
    fn worm_ai(&mut self, e: &mut Enemy, st: EnemyStats, targets: &[Target]) {
        let mid = st.h * POS_ONE / 2;
        let mut best: Option<(i64, i32, i32)> = None;
        for &(_, px, py) in targets {
            let (dx, dy) = (px - e.x, py - CHEST * POS_ONE - (e.y - mid));
            let d2 = i64::from(dx) * i64::from(dx) + i64::from(dy) * i64::from(dy);
            if best.is_none_or(|(b, _, _)| d2 < b) {
                best = Some((d2, dx, dy));
            }
        }
        if e.state & 1 == 0 {
            let wake = i64::from(WORM_WAKE_CELLS * POS_ONE);
            if best.is_some_and(|(d2, _, _)| d2 <= wake * wake) {
                e.state |= 1;
            }
            return;
        }
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        let hunt = i64::from(WORM_HUNT_CELLS * POS_ONE);
        let (cx, cy) = (e.x >> POS_SHIFT, (e.y - mid) >> POS_SHIFT);
        if let Some((_, dx, dy)) = best.filter(|&(d2, _, _)| d2 <= hunt * hunt) {
            let in_rock = cx >= 0 && cy >= 0 && cx < w && cy < h && blocks_enemy(self.grid.mat[(cy * w + cx) as usize]);
            let speed = if in_rock { WORM_SPEED_ROCK } else { WORM_SPEED_OPEN };
            let mx = if dx.abs() * 2 > dy.abs() { dx.signum() * speed } else { 0 };
            let my = if dy.abs() * 2 > dx.abs() { dy.signum() * speed } else { 0 };
            if dx != 0 {
                e.facing = u8::from(dx > 0);
            }
            for (ax, ay) in [(mx, 0), (0, my)] {
                if ax == 0 && ay == 0 {
                    continue;
                }
                let (nx, ny) = (e.x + ax, e.y + ay);
                let (ncx, ncy) = (nx >> POS_SHIFT, (ny - mid) >> POS_SHIFT);
                if ncx < 4 || ncy < 4 || ncx >= w - 4 || ncy >= h - 4 || self.grid.mat[(ncy * w + ncx) as usize] == BEDROCK {
                    continue;
                }
                e.x = nx;
                e.y = ny;
            }
        }
        let (cx, cy) = (e.x >> POS_SHIFT, (e.y - mid) >> POS_SHIFT);
        self.grid.dig(cx, cy, cx, cy, WORM_DIG_RADIUS);
        self.enemy_work += ((2 * WORM_DIG_RADIUS + 1) * (2 * WORM_DIG_RADIUS + 1)) as u32;
    }

    /// The enemies that step this tick: indices in id order, inside the rectangle around some alive active
    /// player, at most `MAX_ENEMIES_STEPPED` of them. Reads only `players` and `enemies`.
    pub fn stepping_set(&self, targets: &[Target]) -> Vec<usize> {
        let (hw, hh) = (ENEMY_ACTIVE_W / 2 * POS_ONE, ENEMY_ACTIVE_H / 2 * POS_ONE);
        let in_range = |e: &Enemy| targets.iter().any(|&(_, px, py)| (e.x - px).abs() <= hw && (e.y - py).abs() <= hh);
        // The boss steps first whenever it is in range (at most one exists), then the lowest ids fill the rest, so a
        // crowd of 24 others can never starve it. The result is in index (= id) order.
        let mut out: Vec<usize> = self.enemies.iter().enumerate().filter(|(_, e)| e.kind == ENEMY_BOSS && in_range(e)).map(|(i, _)| i).take(1).collect();
        for (i, e) in self.enemies.iter().enumerate() {
            if out.len() >= MAX_ENEMIES_STEPPED {
                break;
            }
            if e.kind != ENEMY_BOSS && in_range(e) {
                out.push(i);
            }
        }
        out.sort_unstable();
        out
    }

    pub fn alive_targets(&self) -> Vec<Target> {
        let tick = self.tick;
        self.players.iter().filter(|p| p.alive(tick)).map(|p| (p.id, p.x, p.y)).collect()
    }

    /// One tick of every stepped enemy (see the module comment). Cost: at most 24 enemies, each a target scan
    /// over at most 8 players, a handful of body-collision tests (at most 5 x 4 cells each) and a contact scan.
    pub(crate) fn update_enemies(&mut self) {
        self.enemy_work = 0;
        if self.enemies.is_empty() || self.round_over != 0 || self.in_lobby() {
            return;
        }
        let targets = self.alive_targets();
        let mut trail = ACID_TRAIL_PER_TICK;
        for i in self.stepping_set(&targets) {
            self.step_enemy(i, &targets, &mut trail);
        }
    }

    fn step_enemy(&mut self, i: usize, targets: &[Target], trail: &mut u32) {
        let tick = self.tick;
        let mut e = self.enemies[i].clone();
        let st = ENEMY_STATS[usize::from(e.kind)];
        if e.kind == ENEMY_WORM {
            self.worm_ai(&mut e, st, targets);
            self.enemy_contact(&mut e, st);
            self.enemies[i] = e;
            return;
        }
        // Embedded rescue (a dig or a paint closed rock around it): up to the first free spot above.
        if self.enemy_blocked(e.x, e.y, st.w, st.h) {
            for up in 1..=ENEMY_RESCUE_CELLS {
                if !self.enemy_blocked(e.x, e.y - up * POS_ONE, st.w, st.h) {
                    e.y -= up * POS_ONE;
                    e.vx = 0;
                    e.vy = 0;
                    break;
                }
            }
        }
        // Nearest alive player by squared distance; the first (lowest id) wins a tie.
        if e.kind == ENEMY_IMP {
            self.imp_ai(&mut e, st, targets);
            self.integrate(&mut e, st, false);
            self.enemies[i] = e;
            return;
        }
        if e.kind == ENEMY_BOSS {
            self.boss_ai(&mut e, st, targets);
            let phase = e.state & 0b1100;
            let (ox, oy) = (e.x, e.y);
            self.integrate(&mut e, st, false);
            // The hard leash: a move whose centre ends outside the ellipse is undone (knockback can be 8 cells a tick).
            if let Some(a) = self.arena {
                if !a.contains(e.x >> POS_SHIFT, (e.y - st.h * POS_ONE / 2) >> POS_SHIFT, 0) {
                    e.x = ox;
                    e.y = oy;
                    e.vx = 0;
                    e.vy = 0;
                }
            }
            e.state = (e.state & 0b11) | phase;
            self.enemy_contact(&mut e, st);
            self.enemies[i] = e;
            return;
        }
        let mut best: Option<(i64, i32)> = None;
        for &(_, px, py) in targets {
            let (dx, dy) = (i64::from(px - e.x), i64::from(py - e.y));
            let d2 = dx * dx + dy * dy;
            if best.is_none_or(|(b, _)| d2 < b) {
                best = Some((d2, px - e.x));
            }
        }
        let aggro = i64::from(SLIME_AGGRO_CELLS * POS_ONE);
        let hunt = best.filter(|&(d2, _)| d2 <= aggro * aggro);
        // Grounded: any solid cell under the body counts, so a slime resting on a single corner cell can still hop
        // (the alternative, requiring wider support, would leave it falling forever). Climbing off a corner is the
        // step-up's job.
        let grounded = self.enemy_blocked(e.x, e.y + 1, st.w, st.h);
        if grounded && e.vy >= 0 {
            e.vy = 0;
            e.vx = 0;
            if tick >= e.hop_until {
                let id = u32::from(e.id);
                if let Some((_, dx)) = hunt {
                    if dx != 0 {
                        e.facing = u8::from(dx > 0);
                    }
                    let hop = if e.kind == ENEMY_ACID_SLIME { ACID_SLIME_HOP_VX } else { SLIME_HOP_VX };
                    e.vx = if dx > 0 { hop } else if dx < 0 { -hop } else { 0 } as i16;
                    // A target well above (more than 4 cells) gets a taller hop; the direction is recomputed from the
                    // target on every grounded tick, and landing zeroes vx above, so a hop never slides on.
                    let above = targets.iter().any(|&(_, px, py)| e.y - py > 4 * POS_ONE && (px - e.x).abs() < 24 * POS_ONE);
                    e.vy = -(if above { SLIME_JUMP_VY + SLIME_JUMP_UP_BONUS } else { SLIME_JUMP_VY }) as i16;
                    let extra = if e.kind == ENEMY_ACID_SLIME { ACID_SLIME_HOP_EXTRA } else { 0 };
                    e.hop_until = tick.wrapping_add(SLIME_HOP_BASE + extra + rng(self.seed, tick, id, 0, SALT_ENEMY_HOP) % SLIME_HOP_JITTER);
                    e.state |= 1;
                } else {
                    let r = rng(self.seed, tick, id, 1, SALT_ENEMY_IDLE);
                    // About one idle hop in two, so a quiet slime mostly sits.
                    if r & 1 == 0 {
                        let right = (r >> 1) & 1 == 1;
                        e.facing = u8::from(right);
                        e.vx = if right { SLIME_IDLE_HOP_VX } else { -SLIME_IDLE_HOP_VX } as i16;
                        e.vy = -SLIME_IDLE_JUMP_VY as i16;
                    }
                    e.hop_until = tick.wrapping_add(SLIME_IDLE_BASE + (r >> 2) % SLIME_IDLE_JITTER);
                    e.state &= !1;
                }
            }
        } else {
            e.vy = (i32::from(e.vy) + SLIME_GRAVITY).min(SLIME_FALL_MAX) as i16;
        }
        self.integrate(&mut e, st, true);
        // The acid trail: one ACID cell in the Empty cell at its feet, while hunting, within the per-tick budget.
        if e.kind == ENEMY_ACID_SLIME && e.state & 1 == 1 && *trail > 0 && tick.wrapping_add(u32::from(e.id)).is_multiple_of(ACID_TRAIL_EVERY) {
            let (cx, cy) = (e.x >> POS_SHIFT, (e.y >> POS_SHIFT) - 1);
            let (w, h) = (self.grid.w as i32, self.grid.h as i32);
            if cx >= 0 && cy >= 0 && cx < w && cy < h && self.grid.mat[(cy * w + cx) as usize] == EMPTY {
                self.grid.set((cy * w + cx) as usize, ACID, 0);
                *trail -= 1;
            }
        }
        self.enemy_contact(&mut e, st);
        self.enemies[i] = e;
    }

    /// Move `e` by its velocity: x then y, a cell at a time, then single units to the wall. `step_up` lets a
    /// blocked walker climb a ledge (fliers do not).
    fn integrate(&mut self, e: &mut Enemy, st: EnemyStats, step_up: bool) {
        // Move: x then y, a cell at a time, then single units to the wall.
        let (mut x, mut y) = (e.x, e.y);
        let mut vx = i32::from(e.vx).clamp(-ENEMY_MAX_SPEED, ENEMY_MAX_SPEED);
        let mut vy = i32::from(e.vy).clamp(-ENEMY_MAX_SPEED, ENEMY_MAX_SPEED);
        let (mut rx, mut ry) = (vx, vy);
        while rx != 0 {
            let d = rx.clamp(-POS_ONE, POS_ONE);
            if self.enemy_blocked(x + d, y, st.w, st.h) {
                // Step-up: a blocked move is retried 1, 2 or 3 cells higher (a ledge or a 45-degree slope), while
                // not rising. The loop is bounded (3 tests); gravity then settles the slime onto the new ground.
                {
                    if let Some(k) = (1..=if step_up { SLIME_STEP_UP_CELLS } else { 0 }).find(|&k| !self.enemy_blocked(x + d, y - k * POS_ONE, st.w, st.h)) {
                        y -= k * POS_ONE;
                        x += d;
                        rx -= d;
                        continue;
                    }
                }
                let s = d.signum();
                while !self.enemy_blocked(x + s, y, st.w, st.h) && x + s != x + d {
                    x += s;
                }
                vx = 0;
                break;
            }
            x += d;
            rx -= d;
        }
        while ry != 0 {
            let d = ry.clamp(-POS_ONE, POS_ONE);
            if self.enemy_blocked(x, y + d, st.w, st.h) {
                let s = d.signum();
                while !self.enemy_blocked(x, y + s, st.w, st.h) && y + s != y + d {
                    y += s;
                }
                vy = 0;
                break;
            }
            y += d;
            ry -= d;
        }
        e.x = x;
        e.y = y;
        e.vx = vx as i16;
        e.vy = vy as i16;
        let airborne = !self.enemy_blocked(x, y + 1, st.w, st.h);
        e.state = (e.state & 1) | (u8::from(airborne) << 1);
    }

    /// Contact damage, in player-id order. An enemy with `contact_damage` 0 (the imp) never touches.
    fn enemy_contact(&mut self, e: &mut Enemy, st: EnemyStats) {
        let tick = self.tick;
        if st.contact_damage == 0 {
            return;
        }
        // Contact damage, in player-id order.
        let (x0, y0, x1, y1) = e.hitbox_cells();
        for k in 0..self.players.len() {
            let p = &self.players[k];
            if !p.alive(tick) || tick < e.cooldown_until {
                continue;
            }
            let (px0, py0, px1, py1) = p.hitbox_cells();
            if px1 < x0 || px0 > x1 || py1 < y0 || py0 > y1 {
                continue;
            }
            let (pid, pdx) = (p.id, p.x - e.x);
            e.cooldown_until = tick.wrapping_add(st.contact_cooldown);
            self.apply_damage(k, st.contact_damage, CAUSE_ENEMY_BASE + e.kind);
            let kx = if pdx < 0 { -CONTACT_KNOCK_X } else { CONTACT_KNOCK_X };
            self.events.push(Event { kind: EV_KNOCK, player: pid, a: kx, b: CONTACT_KNOCK_Y, c: 0 });
        }
    }

    // ---- damage (F4 commit 5) ----------------------------------------------------------------------------

    /// Index of the enemy with this id, if it still exists.
    pub(crate) fn enemy_index(&self, id: u16) -> Option<usize> {
        self.enemies.binary_search_by_key(&id, |e| e.id).ok()
    }

    /// Take `amount` hp from the enemy at `idx`, crediting `attacker` (0 for the world, which keeps the previous
    /// credit). The enemy is only marked (hp 0); `reap_enemies` removes it and emits the death, so indices stay
    /// valid while one source loops over several enemies. An enemy already at 0 takes nothing.
    pub fn damage_enemy(&mut self, idx: usize, amount: u16, attacker: u32) {
        let tick = self.tick;
        let e = &mut self.enemies[idx];
        if e.hp == 0 || amount == 0 {
            return;
        }
        if attacker != 0 {
            e.last_hit_by = attacker;
            e.last_hit_tick = tick;
        }
        let dealt = amount.min(e.hp);
        e.hp -= dealt;
        let ev = Event { kind: EV_ENEMY_HURT, player: attacker, a: i32::from(e.id), b: i32::from(dealt), c: i32::from(e.hp) };
        self.events.push(ev);
    }

    /// Knock an enemy: the impulse (1/16 cell per tick) is scaled down and lifted, then clamped. It moves the
    /// enemy's state velocity, which `step_enemy` integrates (players are moved by their own client instead).
    pub(crate) fn knock_enemy(&mut self, idx: usize, vx: i32, vy: i32) {
        let e = &mut self.enemies[idx];
        let (vx, vy) = (vx / ENEMY_KNOCK_DIV, vy / ENEMY_KNOCK_DIV);
        e.vx = vx.clamp(-ENEMY_MAX_SPEED, ENEMY_MAX_SPEED) as i16;
        e.vy = vy.min(-ENEMY_KNOCK_LIFT).clamp(-ENEMY_MAX_SPEED, ENEMY_MAX_SPEED) as i16;
    }

    /// Remove every enemy at 0 hp, in id order, emitting `EV_ENEMY_DEATH` with the credited killer (the last
    /// hitter within `KILL_CREDIT_TICKS`, else 0).
    pub fn reap_enemies(&mut self) {
        if !self.enemies.iter().any(|e| e.hp == 0) {
            return;
        }
        let tick = self.tick;
        let mut dead = Vec::new();
        let mut bursts = Vec::new();
        let mut boss_died = false;
        self.enemies.retain(|e| {
            if e.hp != 0 {
                return true;
            }
            let credited = e.last_hit_by != 0 && tick.wrapping_sub(e.last_hit_tick) <= KILL_CREDIT_TICKS;
            if e.kind == ENEMY_BOSS {
                boss_died = true;
            }
            if e.kind == ENEMY_ACID_SLIME {
                bursts.push((e.x >> POS_SHIFT, (e.y >> POS_SHIFT) - 2));
            }
            dead.push(Event { kind: EV_ENEMY_DEATH, player: if credited { e.last_hit_by } else { 0 }, a: e.x, b: e.y, c: i32::from(e.kind) });
            false
        });
        self.events.extend(dead);
        if boss_died {
            self.round_started |= ROUND_BOSS_KILLED;
        }
        // An acid slime bursts into at most `ACID_DEATH_CELLS` ACID cells (Empty cells only), in id order.
        for at in bursts {
            self.burst(at, ACID, ACID_DEATH_CELLS, false);
        }
    }

    /// Lava, fire and acid contact for the enemies that step this tick, in id order, at the player cadence:
    /// lava 1 hp on even ticks, fire when `(tick + id) % 6 == 0`, acid when `tick % 4 == 0`; lava wins over both,
    /// fire over acid; a per-kind immunity mask skips a hazard. Reads only the enemy's own hitbox (inside the
    /// stepping rectangle), so chunk sleeping cannot change it.
    pub(crate) fn enemy_hazard_scan(&mut self) {
        if self.enemies.is_empty() || self.round_over != 0 || self.in_lobby() {
            return;
        }
        let targets = self.alive_targets();
        let tick = self.tick;
        let (w, h) = (self.grid.w as i32, self.grid.h as i32);
        for i in self.stepping_set(&targets) {
            let e = &self.enemies[i];
            let (immune, weak) = (ENEMY_STATS[usize::from(e.kind)].immune, ENEMY_STATS[usize::from(e.kind)].weak);
            let (x0, y0, x1, y1) = e.hitbox_cells();
            let (mut lava, mut fire, mut acid, mut water) = (false, false, false, false);
            for y in y0.max(0)..=y1.min(h - 1) {
                for x in x0.max(0)..=x1.min(w - 1) {
                    match self.grid.mat[(y * w + x) as usize] {
                        LAVA => lava = immune & IMMUNE_LAVA == 0 || lava,
                        FIRE => fire = immune & IMMUNE_FIRE == 0 || fire,
                        ACID => acid = immune & IMMUNE_ACID == 0 || acid,
                        WATER => water = weak & WEAK_WATER != 0 || water,
                        _ => {}
                    }
                }
            }
            let id = u32::from(e.id);
            let hit = if lava {
                tick.is_multiple_of(2)
            } else if fire {
                tick.wrapping_add(id).is_multiple_of(6)
            } else if acid {
                tick.is_multiple_of(4)
            } else {
                water && tick.wrapping_add(id).is_multiple_of(IMP_WATER_EVERY)
            };
            if hit {
                self.damage_enemy(i, 1, 0);
            }
        }
        self.reap_enemies();
    }
}

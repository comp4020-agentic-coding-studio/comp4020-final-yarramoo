//! Enemies (F4, docs/research/enemies-design.md sections 2-4). Integer-only, bounded, and a pure function of
//! hashed state: the stepping set comes from `players` (never from `grid.awake`), so chunk sleeping is invisible.
//!
//! Stepping rule: an enemy steps on a tick only if it lies inside an `ENEMY_ACTIVE_W x ENEMY_ACTIVE_H` rectangle
//! around an active, alive player; otherwise it is frozen (no movement, timers, AI or contact damage). At most
//! `MAX_ENEMIES_STEPPED` step per tick, lowest ids first. Enemies step in id order, after `update_projectiles`.

use crate::entities::*;
use crate::materials::*;
use crate::rng::{rng, SALT_ENEMY_HOP, SALT_ENEMY_IDLE};
use crate::sim::Sim;
use crate::tuning::*;

/// An alive, active player as the AI sees it: `(id, x, y)` in 1/16 cell.
type Target = (u32, i32, i32);

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

    /// The enemies that step this tick: indices in id order, inside the rectangle around some alive active
    /// player, at most `MAX_ENEMIES_STEPPED` of them. Reads only `players` and `enemies`.
    pub fn stepping_set(&self, targets: &[Target]) -> Vec<usize> {
        let (hw, hh) = (ENEMY_ACTIVE_W / 2 * POS_ONE, ENEMY_ACTIVE_H / 2 * POS_ONE);
        let mut out = Vec::new();
        for (i, e) in self.enemies.iter().enumerate() {
            if out.len() >= MAX_ENEMIES_STEPPED {
                break;
            }
            if targets.iter().any(|&(_, px, py)| (e.x - px).abs() <= hw && (e.y - py).abs() <= hh) {
                out.push(i);
            }
        }
        out
    }

    pub(crate) fn alive_targets(&self) -> Vec<Target> {
        let tick = self.tick;
        self.players.iter().filter(|p| p.alive(tick)).map(|p| (p.id, p.x, p.y)).collect()
    }

    /// One tick of every stepped enemy (see the module comment). Cost: at most 24 enemies, each a target scan
    /// over at most 8 players, a handful of body-collision tests (at most 5 x 4 cells each) and a contact scan.
    pub(crate) fn update_enemies(&mut self) {
        self.enemy_work = 0;
        if self.enemies.is_empty() || self.round_over != 0 {
            return;
        }
        let targets = self.alive_targets();
        for i in self.stepping_set(&targets) {
            self.step_enemy(i, &targets);
        }
    }

    fn step_enemy(&mut self, i: usize, targets: &[Target]) {
        let tick = self.tick;
        let mut e = self.enemies[i].clone();
        let st = ENEMY_STATS[usize::from(e.kind)];
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
        // Grounded: standing on a solid cell.
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
                    e.vx = if dx > 0 { SLIME_HOP_VX } else if dx < 0 { -SLIME_HOP_VX } else { 0 } as i16;
                    e.vy = -SLIME_JUMP_VY as i16;
                    e.hop_until = tick.wrapping_add(SLIME_HOP_BASE + rng(self.seed, tick, id, 0, SALT_ENEMY_HOP) % SLIME_HOP_JITTER);
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
        // Move: x then y, a cell at a time, then single units to the wall.
        let (mut x, mut y) = (e.x, e.y);
        let mut vx = i32::from(e.vx).clamp(-ENEMY_MAX_SPEED, ENEMY_MAX_SPEED);
        let mut vy = i32::from(e.vy).clamp(-ENEMY_MAX_SPEED, ENEMY_MAX_SPEED);
        let (mut rx, mut ry) = (vx, vy);
        while rx != 0 {
            let d = rx.clamp(-POS_ONE, POS_ONE);
            if self.enemy_blocked(x + d, y, st.w, st.h) {
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
        self.enemies[i] = e;
    }
}

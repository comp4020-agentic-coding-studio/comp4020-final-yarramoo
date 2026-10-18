//! Entities (plan 6.6): players and pickups, their canonical bytes, and the render-only views.
//! Everything here is fixed-width little-endian; no `usize` ever reaches the bytes (invariant 7).

use crate::tuning::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Player {
    pub id: u32,
    pub active: bool,
    /// Incremented on each respawn; a Pos with a stale `life` is ignored.
    pub life: u16,
    /// Official position, 1/16 cell: x is the feet centre, y is the feet line (the top edge of the
    /// row the feet stand on, so the hitbox covers the HITBOX_H rows above it).
    pub x: i32,
    pub y: i32,
    pub facing: u8,
    pub health: u8,
    pub dead_until: u32,
    pub charges: [u16; NUM_SPELLS],
    pub cooldown_until: [u32; NUM_SPELLS],
    pub last_hit_by: u32,
    pub last_hit_tick: u32,
}

pub const PLAYER_BYTES: usize = 4 + 1 + 2 + 4 + 4 + 1 + 1 + 4 + 2 * NUM_SPELLS + 4 * NUM_SPELLS + 4 + 4;

impl Player {
    pub fn new(id: u32, x: i32, y: i32) -> Player {
        Player {
            id,
            active: true,
            life: 0,
            x,
            y,
            facing: 0,
            health: HEALTH_MAX,
            dead_until: 0,
            charges: START_CHARGES,
            cooldown_until: [0; NUM_SPELLS],
            last_hit_by: 0,
            last_hit_tick: 0,
        }
    }

    /// Cells overlapped by the hitbox: (x0, y0, x1, y1), inclusive.
    pub fn hitbox_cells(&self) -> (i32, i32, i32, i32) {
        let half = HITBOX_W * POS_ONE / 2;
        (
            (self.x - half) >> POS_SHIFT,
            (self.y - HITBOX_H * POS_ONE) >> POS_SHIFT,
            (self.x + half - 1) >> POS_SHIFT,
            (self.y - 1) >> POS_SHIFT,
        )
    }

    fn write(&self, v: &mut Vec<u8>) {
        v.extend_from_slice(&self.id.to_le_bytes());
        v.push(u8::from(self.active));
        v.extend_from_slice(&self.life.to_le_bytes());
        v.extend_from_slice(&self.x.to_le_bytes());
        v.extend_from_slice(&self.y.to_le_bytes());
        v.push(self.facing);
        v.push(self.health);
        v.extend_from_slice(&self.dead_until.to_le_bytes());
        for c in self.charges {
            v.extend_from_slice(&c.to_le_bytes());
        }
        for c in self.cooldown_until {
            v.extend_from_slice(&c.to_le_bytes());
        }
        v.extend_from_slice(&self.last_hit_by.to_le_bytes());
        v.extend_from_slice(&self.last_hit_tick.to_le_bytes());
    }
}

/// A fixed pickup created by generation; only `charges` (always the spell's grant) and `respawn_at` change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pickup {
    pub id: u16,
    pub spell: u8,
    /// The empty floor cell the pickup sits in.
    pub x: u16,
    pub y: u16,
    pub charges: u16,
    /// Available when `tick >= respawn_at`.
    pub respawn_at: u32,
}

pub const PICKUP_BYTES: usize = 2 + 1 + 2 + 2 + 2 + 4;

impl Pickup {
    fn write(&self, v: &mut Vec<u8>) {
        v.extend_from_slice(&self.id.to_le_bytes());
        v.push(self.spell);
        v.extend_from_slice(&self.x.to_le_bytes());
        v.extend_from_slice(&self.y.to_le_bytes());
        v.extend_from_slice(&self.charges.to_le_bytes());
        v.extend_from_slice(&self.respawn_at.to_le_bytes());
    }
}

/// A spell bolt in flight (plan 6.6). Entity state: hashed and snapshotted, kept in spawn order.
/// `x`, `y`, `vx`, `vy` are in 1/256 cell (and per tick).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Projectile {
    pub owner: u32,
    pub spell: u8,
    pub cast_seq: u16,
    pub x: i32,
    pub y: i32,
    pub vx: i32,
    pub vy: i32,
    /// Ticks since the cast; the owner cannot be hit while this is at most `OWNER_GRACE`.
    pub age: u16,
}

pub const PROJECTILE_BYTES: usize = 4 + 1 + 2 + 4 + 4 + 4 + 4 + 2;

impl Projectile {
    fn write(&self, v: &mut Vec<u8>) {
        v.extend_from_slice(&self.owner.to_le_bytes());
        v.push(self.spell);
        v.extend_from_slice(&self.cast_seq.to_le_bytes());
        v.extend_from_slice(&self.x.to_le_bytes());
        v.extend_from_slice(&self.y.to_le_bytes());
        v.extend_from_slice(&self.vx.to_le_bytes());
        v.extend_from_slice(&self.vy.to_le_bytes());
        v.extend_from_slice(&self.age.to_le_bytes());
    }
}

/// A dropped bag of a dead player's finite charges (M5 slice 3). State: hashed and snapshotted, kept in
/// spawn order. `charges[k]` is spell `2 + k` (Water, Rose, Fire bolt, Bomb); never all zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bag {
    /// The cell the bag occupies.
    pub x: u16,
    pub y: u16,
    pub charges: [u16; BAG_SPELLS],
    /// Removed when `tick >= expires_at`.
    pub expires_at: u32,
}

pub const BAG_BYTES: usize = 2 + 2 + 2 * BAG_SPELLS + 4;

impl Bag {
    /// Total charges held, capped to u16 for the view and events.
    pub fn total(&self) -> u16 {
        self.charges.iter().map(|&c| u32::from(c)).sum::<u32>().min(u32::from(u16::MAX)) as u16
    }

    fn write(&self, v: &mut Vec<u8>) {
        v.extend_from_slice(&self.x.to_le_bytes());
        v.extend_from_slice(&self.y.to_le_bytes());
        for c in self.charges {
            v.extend_from_slice(&c.to_le_bytes());
        }
        v.extend_from_slice(&self.expires_at.to_le_bytes());
    }
}

/// Canonical entity bytes: `n_players u32, players (by id), n_pickups u32, pickups (by id),
/// n_projectiles u32, projectiles (spawn order), n_bags u32, bags (spawn order)`. Players stay first:
/// the server reads the player section at a fixed offset (`activePlayersIn`).
pub fn encode(players: &[Player], pickups: &[Pickup], projectiles: &[Projectile], bags: &[Bag]) -> Vec<u8> {
    let mut v = Vec::with_capacity(
        16 + players.len() * PLAYER_BYTES
            + pickups.len() * PICKUP_BYTES
            + projectiles.len() * PROJECTILE_BYTES
            + bags.len() * BAG_BYTES,
    );
    v.extend_from_slice(&(players.len() as u32).to_le_bytes());
    for p in players {
        p.write(&mut v);
    }
    v.extend_from_slice(&(pickups.len() as u32).to_le_bytes());
    for p in pickups {
        p.write(&mut v);
    }
    v.extend_from_slice(&(projectiles.len() as u32).to_le_bytes());
    for p in projectiles {
        p.write(&mut v);
    }
    v.extend_from_slice(&(bags.len() as u32).to_le_bytes());
    for b in bags {
        b.write(&mut v);
    }
    v
}

struct R<'a>(&'a [u8], usize);
impl R<'_> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let s = self.0.get(self.1..self.1.checked_add(N)?)?;
        self.1 += N;
        let mut a = [0u8; N];
        a.copy_from_slice(s);
        Some(a)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take::<1>().map(|a| a[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take().map(u16::from_le_bytes)
    }
    fn u32(&mut self) -> Option<u32> {
        self.take().map(u32::from_le_bytes)
    }
    fn i32(&mut self) -> Option<i32> {
        self.take().map(i32::from_le_bytes)
    }
}

/// Decode entity bytes against the freshly generated `pickups` (their identity must match; only
/// `respawn_at` and `charges` are taken from the bytes). Hostile input fails cleanly, never panics.
/// `w`, `h` are the world's size in cells: a bag outside it is refused.
pub type Decoded = (Vec<Player>, Vec<Projectile>, Vec<Bag>);

pub fn decode(b: &[u8], pickups: &mut [Pickup], w: usize, h: usize) -> Result<Decoded, ()> {
    let mut r = R(b, 0);
    let np = r.u32().ok_or(())? as usize;
    // Compare in u64 so a crafted count cannot wrap a 32-bit usize.
    if np > MAX_PLAYERS {
        return Err(());
    }
    // Everything up to the projectile count has a fixed size once np is known; the count then fixes the rest.
    let fixed = (np as u64) * (PLAYER_BYTES as u64) + 12 + (pickups.len() * PICKUP_BYTES) as u64;
    if (b.len() as u64) < fixed {
        return Err(());
    }
    let tail = u32::from_le_bytes(b[(fixed - 4) as usize..fixed as usize].try_into().map_err(|_| ())?) as usize;
    if tail > MAX_PROJECTILES {
        return Err(());
    }
    // The bag count follows the projectiles; it then fixes the exact total length.
    let bag_at = fixed + (tail as u64) * (PROJECTILE_BYTES as u64);
    if (b.len() as u64) < bag_at + 4 {
        return Err(());
    }
    let nb = u32::from_le_bytes(b[bag_at as usize..bag_at as usize + 4].try_into().map_err(|_| ())?) as usize;
    if nb > MAX_BAGS || bag_at + 4 + (nb as u64) * (BAG_BYTES as u64) != b.len() as u64 {
        return Err(());
    }
    let mut players: Vec<Player> = Vec::with_capacity(np);
    for _ in 0..np {
        let id = r.u32().ok_or(())?;
        let active = r.u8().ok_or(())?;
        if active > 1 || players.last().is_some_and(|p| p.id >= id) {
            return Err(());
        }
        let mut p = Player::new(id, 0, 0);
        p.active = active == 1;
        p.life = r.u16().ok_or(())?;
        p.x = r.i32().ok_or(())?;
        p.y = r.i32().ok_or(())?;
        p.facing = r.u8().ok_or(())?;
        p.health = r.u8().ok_or(())?;
        p.dead_until = r.u32().ok_or(())?;
        for c in p.charges.iter_mut() {
            *c = r.u16().ok_or(())?;
        }
        for c in p.cooldown_until.iter_mut() {
            *c = r.u32().ok_or(())?;
        }
        p.last_hit_by = r.u32().ok_or(())?;
        p.last_hit_tick = r.u32().ok_or(())?;
        players.push(p);
    }
    if r.u32().ok_or(())? as usize != pickups.len() {
        return Err(());
    }
    for pk in pickups.iter_mut() {
        let (id, spell, x, y) = (r.u16().ok_or(())?, r.u8().ok_or(())?, r.u16().ok_or(())?, r.u16().ok_or(())?);
        if (id, spell, x, y) != (pk.id, pk.spell, pk.x, pk.y) {
            return Err(());
        }
        pk.charges = r.u16().ok_or(())?;
        pk.respawn_at = r.u32().ok_or(())?;
    }
    let n = r.u32().ok_or(())? as usize;
    if n != tail {
        return Err(());
    }
    let mut projectiles = Vec::with_capacity(n);
    for _ in 0..n {
        let owner = r.u32().ok_or(())?;
        let spell = r.u8().ok_or(())?;
        if usize::from(spell) >= NUM_SPELLS {
            return Err(());
        }
        projectiles.push(Projectile {
            owner,
            spell,
            cast_seq: r.u16().ok_or(())?,
            x: r.i32().ok_or(())?,
            y: r.i32().ok_or(())?,
            vx: r.i32().ok_or(())?,
            vy: r.i32().ok_or(())?,
            age: r.u16().ok_or(())?,
        });
    }
    if r.u32().ok_or(())? as usize != nb {
        return Err(());
    }
    let mut bags = Vec::with_capacity(nb);
    for _ in 0..nb {
        let (x, y) = (r.u16().ok_or(())?, r.u16().ok_or(())?);
        let mut charges = [0u16; BAG_SPELLS];
        for c in charges.iter_mut() {
            *c = r.u16().ok_or(())?;
        }
        if usize::from(x) >= w || usize::from(y) >= h || charges.iter().all(|&c| c == 0) {
            return Err(());
        }
        bags.push(Bag { x, y, charges, expires_at: r.u32().ok_or(())? });
    }
    Ok((players, projectiles, bags))
}

// ---- render-only views (plan 6.11; invariant 9: nothing read from these may become an input) ----------

pub const EV_SPAWN: u8 = 1;
pub const EV_PICKUP: u8 = 2;
/// A cast that was accepted: `player` = caster, a = spell, b = angle, c = cast_seq.
pub const EV_CAST: u8 = 3;
/// A cast that was refused: a = spell, b = reason (`REJECT_*`), c = cast_seq.
pub const EV_CAST_REJECTED: u8 = 4;
/// `player` = victim, a = vx, b = vy (1/16 cell per tick), c = attacker. The sim does not move the victim.
pub const EV_KNOCK: u8 = 5;
/// A projectile ended: `player` = owner, a, b = cell x, y, c = spell.
pub const EV_IMPACT: u8 = 6;
/// A player was put back at the spawn point: a, b = x, y (1/16 cell), c = new life.
pub const EV_RESPAWN: u8 = 7;
/// An explosion: `player` = owner (0 for gunpowder), a, b = centre cell x, y, c = radius in cells.
pub const EV_EXPLODE: u8 = 8;
/// A player died: `player` = victim, a = killer (0 if none), b = cause (`CAUSE_*` or a spell id), c = 0
/// (reserved: slice 3 sets it to 1 when a bag dropped).
pub const EV_DEATH: u8 = 9;
/// A bag was taken: `player` = taker, a, b = the bag's cell x, y, c = total charges taken.
pub const EV_BAG_PICKUP: u8 = 10;
pub const REJECT_SPELL: i32 = 1;
pub const REJECT_CHARGES: i32 = 2;
pub const REJECT_COOLDOWN: i32 = 3;
pub const REJECT_FULL: i32 = 4;
pub const REJECT_DEAD: i32 = 5;
/// Event record: `kind u8, player u32, a i32, b i32, c i32`.
pub const EVENT_BYTES: usize = 17;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Event {
    pub kind: u8,
    pub player: u32,
    pub a: i32,
    pub b: i32,
    pub c: i32,
}

impl Event {
    pub fn write(&self, o: &mut [u8]) {
        o[0] = self.kind;
        o[1..5].copy_from_slice(&self.player.to_le_bytes());
        o[5..9].copy_from_slice(&self.a.to_le_bytes());
        o[9..13].copy_from_slice(&self.b.to_le_bytes());
        o[13..17].copy_from_slice(&self.c.to_le_bytes());
    }
}

pub const ENT_PLAYER: u8 = 1;
pub const ENT_PICKUP: u8 = 2;
/// Projectile view record: `id` = owner, `sub` = spell, x, y in 1/16 cell, `a` = cast_seq.
pub const ENT_PROJECTILE: u8 = 3;
/// A dropped bag: `id` = index, `active` = 1, x, y = the cell centre in 1/16 cell, `a` = total charges (capped to u16).
pub const ENT_BAG: u8 = 4;
/// Entity record: `type u8, id u32, active u8, sub u8, x i32, y i32, a u16, health u8`.
pub const ENTITY_BYTES: usize = 18;

/// Entity views for the renderer, players then pickups, written into `out` (at most `max` records).
pub fn write_view(players: &[Player], pickups: &[Pickup], projectiles: &[Projectile], bags: &[Bag], tick: u32, out: &mut [u8], max: usize) -> usize {
    let mut n = 0;
    let mut put = |t: u8, id: u32, active: bool, sub: u8, x: i32, y: i32, a: u16, health: u8| {
        if n >= max || (n + 1) * ENTITY_BYTES > out.len() {
            return;
        }
        let o = &mut out[n * ENTITY_BYTES..(n + 1) * ENTITY_BYTES];
        o[0] = t;
        o[1..5].copy_from_slice(&id.to_le_bytes());
        o[5] = u8::from(active);
        o[6] = sub;
        o[7..11].copy_from_slice(&x.to_le_bytes());
        o[11..15].copy_from_slice(&y.to_le_bytes());
        o[15..17].copy_from_slice(&a.to_le_bytes());
        o[17] = health;
        n += 1;
    };
    for p in players {
        put(ENT_PLAYER, p.id, p.active, p.facing, p.x, p.y, p.life, p.health);
    }
    for k in pickups {
        // Same anchor as a player: the feet line under the cell, centred on it.
        put(
            ENT_PICKUP,
            u32::from(k.id),
            tick >= k.respawn_at,
            k.spell,
            i32::from(k.x) * POS_ONE + POS_ONE / 2,
            (i32::from(k.y) + 1) * POS_ONE,
            k.charges,
            0,
        );
    }
    for q in projectiles {
        put(ENT_PROJECTILE, q.owner, true, q.spell, q.x >> 4, q.y >> 4, q.cast_seq, 0);
    }
    for (i, b) in bags.iter().enumerate() {
        put(ENT_BAG, i as u32, true, 0, i32::from(b.x) * POS_ONE + POS_ONE / 2, i32::from(b.y) * POS_ONE + POS_ONE / 2, b.total(), 0);
    }
    n
}

/// Per-spell HUD record for one player: `charges u16[NUM_SPELLS]`, then ticks of cooldown left `u16[NUM_SPELLS]`.
pub const PLAYER_VIEW_BYTES: usize = 4 * NUM_SPELLS;

pub fn write_player_view(p: &Player, tick: u32, out: &mut [u8]) {
    for k in 0..NUM_SPELLS {
        out[2 * k..2 * k + 2].copy_from_slice(&p.charges[k].to_le_bytes());
        let left = p.cooldown_until[k].saturating_sub(tick).min(u32::from(u16::MAX)) as u16;
        let o = 2 * NUM_SPELLS + 2 * k;
        out[o..o + 2].copy_from_slice(&left.to_le_bytes());
    }
}


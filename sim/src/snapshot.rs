//! Canonical snapshot (plan 6.10). Little-endian, fixed-width fields only.

use crate::config::{RoomConfig, CONFIG_BYTES};
use crate::grid::{CHUNK, CHUNK_AREA};
use crate::sim::Sim;
use crate::tuning::LOBBY_IDLE;

pub const MAGIC: &[u8; 4] = b"SAND";
/// v2 added entities; v3 appended the bag section (D-110); v4 (R0a) replaces the world-kind byte with the 16
/// room-config bytes; v5 (F1) adds Dig, so the player record grows by one spell slot; v6 (F3) adds five spells and widens the bag to every finite spell; v7 (F4) appends the enemy section and `round_over` to the entity bytes; v8 (F4 fix pass) widens the tail to `round_over, round_running, round_result`. v9 (F6b) adds a `ready` byte to each player and `lobby_since` u32 to the round tail. v10 (Brief W) appends the woken-chunk bitset after the chunk records. v11 (Brief E) adds the heal section (count, then heals) between the enemies and the round tail. v12 (Brief HF) names the packed fields: the round tail is `over, running, boss_killed, result, lobby_since, majority_since` (12 bytes), and each enemy record ends with `phase u8, summons u16` (boss phase and summon counter, zero for other kinds; `state` keeps bits 0-1 and `hop_until` only the next hop). v13 (N4, D-189) adds the falling-island list (count u8, then that many u32 cell indices) between the chunk records and the woken bitset. v14 (biomes): new generation; no layout change, bumped so stored worlds made by the old generator reset. v15 (INT-2, D-205) adds `last_hp u16` to each enemy record (the Sand Colossus's last-seen hp; zero for other kinds). v16 (INT-3) adds Freeze, Quake and Mudslide (spell ids 12-14), so the player record and the bag record grow, and four materials (25-28). v17 (world-life): new generation (canopies, shrubs, wildflowers); no layout change. v18 (quality-W1): new generation (boss supply alcove 12 rows tall, pickup spots need a whole 5x10 body of headroom); no layout change. Restore refuses any other version (the game is not live, so no stored state is lost).
pub const FORMAT_VERSION: u16 = 18;
const CFG_AT: usize = 4 + 2 + 32 + 8;
const HEADER: usize = CFG_AT + CONFIG_BYTES + 4 + 2 + 2;

pub fn write(s: &Sim) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(MAGIC);
    v.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    v.extend_from_slice(&[0u8; 32]); // sim_build_hash: filled in by the TS side
    v.extend_from_slice(&s.seed.to_le_bytes());
    v.extend_from_slice(&s.cfg.encode());
    v.extend_from_slice(&s.tick.to_le_bytes());
    v.extend_from_slice(&(s.grid.w as u16).to_le_bytes());
    v.extend_from_slice(&(s.grid.h as u16).to_le_bytes());
    // Entity section: byte length, then the canonical entity bytes (see `entities::encode`).
    let e = s.entity_bytes();
    v.extend_from_slice(&(e.len() as u32).to_le_bytes());
    v.extend_from_slice(&e);
    let live: Vec<usize> = (0..s.grid.chunk_count()).filter(|&c| !s.grid.pristine[c]).collect();
    v.extend_from_slice(&(live.len() as u32).to_le_bytes());
    for c in live {
        v.extend_from_slice(&(c as u16).to_le_bytes());
        for plane in [&s.grid.mat, &s.grid.aux] {
            let (cx, cy) = (c % s.grid.cw, c / s.grid.cw);
            for y in cy * CHUNK..(cy + 1) * CHUNK {
                let o = y * s.grid.w + cx * CHUNK;
                v.extend_from_slice(&plane[o..o + CHUNK]);
            }
        }
    }
    v.push(s.grid.falls.len() as u8);
    for &f in &s.grid.falls {
        v.extend_from_slice(&f.to_le_bytes());
    }
    v.extend_from_slice(&crate::hash::pack_woken(&s.grid.woken));
    v
}

/// Exactly `write(s).len()`, by construction: a hand-computed size drifts from `write` as soon as a
/// section grows, and the ABI caller allocates from this, so drift is a buffer overrun.
pub fn size(s: &Sim) -> usize {
    write(s).len()
}

pub fn restore(b: &[u8]) -> Result<Sim, ()> {
    restore_with(b, None)
}

/// Restore, starting from `base` when it is the same (seed, config) world and regenerating otherwise. The
/// result is identical either way. A game-world result carries a base (the one used, or a fresh one).
pub fn restore_with(b: &[u8], base: Option<&crate::sim::Base>) -> Result<Sim, ()> {
    if b.len() < HEADER + 8 || &b[0..4] != MAGIC {
        return Err(());
    }
    let u16_at = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
    let u32_at = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    if u16_at(4) != FORMAT_VERSION {
        return Err(());
    }
    let mut sd = [0u8; 8];
    sd.copy_from_slice(&b[38..46]);
    let seed = u64::from_le_bytes(sd);
    let cfg = RoomConfig::decode(&b[CFG_AT..CFG_AT + CONFIG_BYTES]).ok_or(())?;
    let t = CFG_AT + CONFIG_BYTES;
    let tick = u32_at(t);
    let (w, h) = (u16_at(t + 4) as usize, u16_at(t + 6) as usize);
    let mut s = Sim::new_with_base(seed, cfg, base).ok_or(())?;
    if s.grid.w != w || s.grid.h != h {
        return Err(());
    }
    let mut o = HEADER;
    let elen = u32_at(o) as usize;
    o += 4;
    // The length must fit inside the buffer with room for the chunk count (checked without overflow).
    let eend = o.checked_add(elen).filter(|&e| e.checked_add(4).is_some_and(|x| x <= b.len())).ok_or(())?;
    if !cfg.has_players() {
        // A world without avatars has no entity section.
        if elen != 0 {
            return Err(());
        }
    } else {
        let round;
        (s.players, s.projectiles, s.bags, s.enemies, s.heals, round) = crate::entities::decode(&b[o..eend], &mut s.pickups, w, h)?;
        // Enemies only exist in rooms that have them; a snapshot that says otherwise is hostile.
        if (!s.enemies.is_empty() || !s.heals.is_empty()) && !cfg.has_enemies() {
            return Err(());
        }
        // A heal never outlives `HEAL_LIFETIME` from now: a larger `expires_at` is hostile (an immortal heal holding a
        // slot, review E). Compared as a wrapping distance, like every other tick in the sim.
        if s.heals.iter().any(|k| k.expires_at.wrapping_sub(tick) > crate::tuning::HEAL_LIFETIME) {
            return Err(());
        }
        [s.round_over, s.round_running, s.boss_killed, s.round_result] = [round[0], round[1], round[2], round[3]];
        s.lobby_since = u32::from_le_bytes([round[4], round[5], round[6], round[7]]);
        s.majority_since = u32::from_le_bytes([round[8], round[9], round[10], round[11]]);
    }
    o = eend;
    let n = u32_at(o) as usize;
    o += 4;
    let rec = 2 + 2 * CHUNK_AREA;
    // A crafted count must not wrap the length check on wasm32 (usize is 32-bit there).
    let wlen = s.grid.chunk_count().div_ceil(8);
    if n > s.grid.chunk_count() {
        return Err(());
    }
    // Chunk records, then the falling list (count u8 + u32 each), then the woken bitset to the end.
    let fat = n.checked_mul(rec).and_then(|x| x.checked_add(o)).filter(|&x| x < b.len()).ok_or(())?;
    let fnum = b[fat] as usize;
    if fnum > crate::tuning::FALL_MAX_ISLANDS || fat + 1 + 4 * fnum + wlen != b.len() {
        return Err(());
    }
    for k in 0..fnum {
        let f = u32_at(fat + 1 + 4 * k) as usize;
        // A falling seed lies on a structural cell, but the chunk records are not copied in yet: check below.
        if f >= w * h {
            return Err(());
        }
        s.grid.falls.push(f as u32);
    }
    let mut prev: Option<usize> = None;
    for _ in 0..n {
        let c = u16_at(o) as usize;
        if c >= s.grid.chunk_count() || prev.is_some_and(|p| c <= p) {
            return Err(());
        }
        prev = Some(c);
        o += 2;
        let (cx, cy) = (c % s.grid.cw, c / s.grid.cw);
        for plane in 0..2 {
            for r in 0..CHUNK {
                let d = (cy * CHUNK + r) * w + cx * CHUNK;
                let src = &b[o..o + CHUNK];
                if plane == 0 {
                    s.grid.mat[d..d + CHUNK].copy_from_slice(src);
                } else {
                    s.grid.aux[d..d + CHUNK].copy_from_slice(src);
                }
                o += CHUNK;
            }
        }
        s.grid.mark_chunk(c);
    }
    // The woken bitset: padding bits must be zero (one canonical encoding).
    let wb = &b[b.len() - wlen..];
    for c in 0..s.grid.chunk_count() {
        s.grid.woken[c] = wb[c / 8] >> (c % 8) & 1 == 1;
    }
    if s.grid.chunk_count() % 8 != 0 && wb[wlen - 1] >> (s.grid.chunk_count() % 8) != 0 {
        return Err(());
    }
    // Every falling seed must sit on a structural cell (a crafted list cannot make the sim read nonsense).
    if s.grid.falls.iter().any(|&f| !crate::grid::is_structural(s.grid.mat[f as usize])) {
        return Err(());
    }
    s.tick = tick;
    // A countdown cannot have begun in the snapshot's future, and a room without a round carries no lobby state.
    let bad_since = |v: u32| v != LOBBY_IDLE && v > tick;
    if bad_since(s.lobby_since) || bad_since(s.majority_since) || (s.cfg.round != 1 && (s.lobby_since != LOBBY_IDLE || s.majority_since != LOBBY_IDLE || s.players.iter().any(|p| p.ready != 0))) {
        return Err(());
    }
    Ok(s)
}

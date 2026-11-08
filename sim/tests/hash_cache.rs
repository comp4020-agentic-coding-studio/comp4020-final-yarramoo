//! The chunk-hash cache must never go stale (review 8 Nov, S1). The state hash reuses a chunk's cached hash until
//! the chunk is marked `dirty_since_hash`, which only `touch`/`set`/`mark_chunk` do. A rule that writes `mat` or
//! `aux` directly and forgets `touch` leaves every client that played through agreeing on a stale hash, while a
//! joiner that restored from a snapshot recomputes from the real bytes, disagrees, and is resynced and kicked.
//!
//! So: step busy worlds, and at every check compare the cached state hash with the hash recomputed after marking
//! every chunk dirty. Marking `dirty_since_hash` only refreshes the cache; it changes no simulation state, so the
//! check does not perturb the run.
use sim::config::RoomConfig;
use sim::input::{encode_cast, encode_join, encode_paint, encode_pos, encode_ready};
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;

type Script = Vec<(u32, Vec<u8>)>;

fn p(mat: u8, x0: i16, y0: i16, x1: i16, y1: i16, r: u8) -> Vec<u8> {
    encode_paint(1, mat, x0, y0, x1, y1, r)
}

/// The cached hash, then the hash with every chunk recomputed from the real bytes; panics on a mismatch.
fn check(s: &mut Sim, what: &str, t: u32) {
    let cached = s.state_hash();
    s.grid.dirty_since_hash.fill(true);
    let fresh = s.state_hash();
    assert_eq!(cached, fresh, "{what}: cached state hash went stale at tick {t}");
    // The twin bug: a changed chunk left `pristine` is left out of snapshots, so a joiner restores the old bytes.
    let r = snapshot::restore(&snapshot::write(s)).expect("own snapshot restores");
    let mut r = r;
    assert_eq!(r.state_hash(), fresh, "{what}: a snapshot at tick {t} restores to a different hash");
}

/// Like `check`, but finds which chunks were stale (the cache before the refresh, against after it).
fn check_chunks(s: &mut Sim, what: &str, t: u32) {
    s.state_hash();
    let cached = s.grid.hash_cache.clone();
    s.grid.dirty_since_hash.fill(true);
    s.state_hash();
    let stale: Vec<usize> = (0..cached.len()).filter(|&c| cached[c] != s.grid.hash_cache[c]).collect();
    assert!(stale.is_empty(), "{what}: chunk-hash cache stale at tick {t}, chunks {stale:?}");
}

fn sandbox(what: &str, seed: u64, ticks: u32, every: u32, script: &Script) {
    let mut s = Sim::new(seed, RoomConfig::classic_sandbox()).unwrap();
    for t in 1..=ticks {
        for (_, b) in script.iter().filter(|(tt, _)| *tt == t) {
            assert_eq!(s.push_input(b), 0);
        }
        s.step();
        if t % every == 0 {
            check_chunks(&mut s, what, t);
        }
    }
    check(&mut s, what, ticks);
}

/// S1's own case: painted ice on the x = 127 column (chunk 1), water across the edge at x = 128 (chunk 2), and
/// nothing else in chunk 1 that moves. The ice's `aux` drops each time it freezes a neighbour; only chunk 2 sees a
/// `set`, so chunk 1's cached hash keeps the old budget unless the ice touches its own cell.
#[test]
fn ice_freezing_across_a_chunk_edge_dirties_its_own_chunk() {
    let script: Script = vec![
        // A rock basin from x = 120 to x = 140 on y = 300, walls at both ends.
        (1, p(ROCK, 120, 300, 140, 300, 0)),
        (1, p(ROCK, 120, 260, 120, 300, 0)),
        (1, p(ROCK, 140, 260, 140, 300, 0)),
        // An ice column at x = 127 (the last column of chunk 1), and a wall at x = 126 so chunk 1 holds only rock and ice.
        (1, p(ROCK, 126, 262, 126, 299, 0)),
        (2, p(ICE, 127, 262, 127, 299, 0)),
        // Water filling the right half of the basin (chunk 2).
        (5, p(WATER, 128, 262, 139, 299, 0)),
        (6, p(WATER, 130, 262, 137, 299, 0)),
    ];
    sandbox("ice by water at x = 127|128", 21, 400, 1, &script);
}

/// A busy sandbox: every material straddling the x = 128 and 256 edges, fire, explosions, ice, acid, seeds, coal,
/// thermite, falling rock (an erased support), hashed every tick.
#[test]
fn a_busy_sandbox_never_leaves_the_hash_cache_stale() {
    let script: Script = vec![
        (1, p(ROCK, 100, 440, 160, 440, 2)),
        (2, p(ICE, 120, 435, 136, 435, 3)),
        (3, p(WATER, 138, 430, 150, 432, 3)),
        (1, p(ROCK, 230, 300, 290, 300, 2)),
        (2, p(WATER, 240, 290, 280, 294, 4)),
        (60, p(OIL, 250, 250, 262, 250, 5)),
        (1, p(SAND, 100, 200, 120, 200, 5)),
        (1, p(ROCK, 90, 240, 150, 240, 3)),
        (80, p(ACID, 125, 200, 131, 200, 4)),
        (1, p(ROCK, 300, 360, 380, 360, 2)),
        (2, p(GAS, 310, 365, 370, 380, 6)),
        (120, p(FIRE, 340, 395, 342, 395, 1)),
        (1, p(COAL, 20, 300, 130, 300, 2)),
        (90, p(FIRE, 20, 296, 22, 296, 1)),
        (1, p(GUNPOWDER, 140, 160, 200, 160, 2)),
        (100, p(FIRE, 200, 160, 202, 160, 1)),
        (1, p(DIRT, 60, 410, 140, 420, 4)),
        (2, p(SEED, 60, 404, 140, 404, 2)),
        (3, p(WATER, 70, 395, 75, 398, 2)),
        (1, p(WOOD, 400, 200, 470, 230, 6)),
        (150, p(FIRE, 400, 199, 402, 199, 1)),
        (1, p(THERMITE, 250, 120, 262, 124, 3)),
        (40, p(LAVA, 256, 110, 258, 112, 2)),
        (1, p(SALT, 180, 60, 200, 62, 2)),
        (1, p(SNOW, 200, 40, 220, 42, 2)),
        (1, p(MUD, 300, 60, 320, 62, 2)),
        (1, p(MOSS, 330, 450, 380, 450, 2)),
        (1, p(MUSHROOM, 390, 450, 420, 450, 2)),
        (1, p(BRICK, 420, 100, 470, 140, 6)),
        (1, p(PEBBLES, 100, 80, 120, 82, 2)),
        (200, p(EMPTY, 430, 135, 470, 145, 8)),
        (250, p(LAVA, 126, 420, 126, 424, 3)),
        (300, p(EMPTY, 100, 430, 160, 445, 6)),
    ];
    sandbox("busy sandbox", 13, 900, 1, &script);
}

/// Game worlds: players walk (frozen and woken chunks), cast every spell, enemies act; checked every 5 ticks.
fn players(what: &str, seed: u64, cfg: RoomConfig, ticks: u32, casts: &[u8]) {
    let mut s = Sim::new(seed, cfg).unwrap();
    s.push_input(&encode_join(1));
    s.push_input(&encode_join(2));
    s.step();
    if cfg.round == 1 {
        s.push_input(&encode_ready(1, 1));
        s.push_input(&encode_ready(2, 1));
    }
    let mut seq = 0u16;
    for t in 1..=ticks {
        if !casts.is_empty() && t % 15 == 5 {
            seq += 1;
            let spell = casts[seq as usize % casts.len()];
            s.push_input(&encode_cast(1 + (seq % 2) as u32, spell, (seq as u32 * 7919 % 65536) as u16, seq));
        }
        if t % 30 == 0 {
            for id in 1..=2u32 {
                if let Some(pl) = s.players.iter().find(|pl| pl.id == id) {
                    let dx = if (t / 300) % 2 == 0 { 160 } else { -160 } * id as i32;
                    s.push_input(&encode_pos(id, pl.life, pl.x + dx, pl.y, (t / 300 % 2) as u8));
                }
            }
        }
        s.step();
        if t % 5 == 0 {
            check_chunks(&mut s, what, t);
        }
    }
    check(&mut s, what, ticks);
}

#[test]
fn game_worlds_never_leave_the_hash_cache_stale() {
    let creative = RoomConfig { size: 1, ..RoomConfig::creative() };
    players("creative spells", 5, creative, 1200, &[4, 5, 2, 6, 7, 8, 10, 9, 1, 0, 3, 11, 12, 13]);
    players("survival", 7, RoomConfig::survival(), 1200, &[]);
}

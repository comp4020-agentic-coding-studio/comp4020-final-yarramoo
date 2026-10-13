#![allow(clippy::manual_is_multiple_of)]
//! M4a: player entities, pickups, the active set from players, entity bytes in the hash and snapshot.
use sim::input::{encode_join, encode_leave, encode_paint, encode_pos};
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

fn push(s: &mut Sim, b: Vec<u8>) {
    assert_eq!(s.push_input(&b), 0);
}

/// A scripted multi-player run: joins, moves (some onto pickups), a leave and a rejoin.
fn script(s: &Sim, t: u32) -> Vec<Vec<u8>> {
    let mut v = vec![];
    let (cx, sy) = (1024 * PX, 230 * PX);
    match t {
        1 => v.push(encode_join(1)),
        3 => v.push(encode_join(2)),
        5 => v.push(encode_pos(1, 0, cx + 20 * PX, sy, 1)),
        7 => v.push(encode_pos(2, 0, cx - 30 * PX, sy, 0)),
        40 => v.push(encode_leave(1)),
        90 => v.push(encode_join(1)),
        _ => {}
    }
    if t >= 100 && t % 10 == 0 {
        // Player 2 walks onto each pickup in turn.
        let k = ((t / 10) as usize) % s.pickups.len();
        let p = &s.pickups[k];
        v.push(encode_pos(2, 0, i32::from(p.x) * PX + PX / 2, (i32::from(p.y) + 1) * PX, 1));
    }
    v
}

fn run_to(s: &mut Sim, from: u32, to: u32) {
    for t in from..=to {
        for b in script(s, t) {
            push(s, b);
        }
        s.step();
    }
}

#[test]
fn join_leave_pos_life_and_spawn_event() {
    let mut s = Sim::new(3, 1).unwrap();
    push(&mut s, encode_join(7));
    s.step();
    assert_eq!(s.events.len(), 1);
    assert_eq!(s.events[0].kind, sim::entities::EV_SPAWN);
    let p = s.players[0].clone();
    assert!(p.active && p.health == 100 && p.charges[0] == INFINITE && p.charges[2] == 0);
    // Spawn is on the surface near the centre, standing on the ground.
    let (gx, gy) = (p.x >> POS_SHIFT, p.y >> POS_SHIFT);
    assert!((gx - 1024).abs() <= 60, "spawn x {gx}");
    assert!((200..270).contains(&gy), "spawn y {gy}");
    assert!(matches!(s.grid.mat[gy as usize * s.grid.w + gx as usize], 2..=4));
    // Pos with the right life moves it; a stale life is ignored.
    push(&mut s, encode_pos(7, 0, 100 * PX, 50 * PX, 1));
    s.step();
    assert_eq!((s.players[0].x, s.players[0].y, s.players[0].facing), (100 * PX, 50 * PX, 1));
    push(&mut s, encode_pos(7, 9, 5 * PX, 5 * PX, 0));
    s.step();
    assert_eq!(s.players[0].x, 100 * PX);
    // Leave deactivates but keeps the entity; Pos from an inactive player is ignored; rejoin reuses it.
    push(&mut s, encode_leave(7));
    s.step();
    assert!(!s.players[0].active);
    push(&mut s, encode_pos(7, 0, 9 * PX, 9 * PX, 0));
    s.step();
    assert_eq!(s.players[0].x, 100 * PX);
    push(&mut s, encode_join(7));
    s.step();
    assert_eq!(s.players.len(), 1);
    assert!(s.players[0].active && s.players[0].x == 100 * PX);
    // An unknown id's Pos or Leave creates nothing; sorted by id.
    push(&mut s, encode_pos(99, 0, 1, 1, 0));
    push(&mut s, encode_leave(99));
    push(&mut s, encode_join(3));
    s.step();
    assert_eq!(s.players.iter().map(|p| p.id).collect::<Vec<_>>(), vec![3, 7]);
    // Out-of-range positions are clamped to the world.
    push(&mut s, encode_pos(7, 0, i32::MAX, i32::MIN, 3));
    s.step();
    assert_eq!(s.players[1].x, 2047 * PX);
    assert_eq!((s.players[1].y, s.players[1].facing), (0, 1));
}

#[test]
fn sandbox_has_no_entities() {
    let mut s = Sim::new(1, 0).unwrap();
    push(&mut s, encode_join(1));
    push(&mut s, encode_pos(1, 0, 5, 5, 0));
    s.step();
    assert!(s.players.is_empty() && s.entity_bytes().is_empty());
}

#[test]
fn pickups_exist_alternate_spells_collect_and_respawn() {
    let mut s = Sim::new(2, 1).unwrap();
    assert!(s.pickups.len() >= 48);
    assert!(s.pickups.iter().all(|k| (2..=5).contains(&k.spell)));
    assert!(s.pickups.iter().any(|k| k.spell == 2) && s.pickups.iter().any(|k| k.spell == 3));
    let k = s.pickups[0].clone();
    push(&mut s, encode_join(1));
    s.step();
    let at = |s: &mut Sim, tick_in: u32| {
        let _ = tick_in;
        push(s, encode_pos(1, 0, i32::from(k.x) * PX + PX / 2, (i32::from(k.y) + 1) * PX, 0));
        s.step();
    };
    at(&mut s, 0);
    assert_eq!(s.players[0].charges[k.spell as usize], k.charges);
    assert!(s.events.iter().any(|e| e.kind == sim::entities::EV_PICKUP));
    // Standing there again does nothing until the respawn tick.
    for _ in 0..10 {
        s.step();
    }
    assert_eq!(s.players[0].charges[k.spell as usize], k.charges);
    let collected_at = s.pickups[0].respawn_at - PICKUP_RESPAWN;
    while s.tick < collected_at + PICKUP_RESPAWN {
        s.step();
    }
    s.step();
    assert_eq!(s.players[0].charges[k.spell as usize], 2 * k.charges);
    // Overlap uses the 5 x 10 hitbox: one cell outside it collects nothing.
    let k2 = s.pickups[1].clone();
    push(&mut s, encode_pos(1, 0, (i32::from(k2.x) + 4) * PX, (i32::from(k2.y) + 1) * PX, 0));
    s.step();
    assert_eq!(s.pickups[1].respawn_at, 0);
}

#[test]
fn a_frozen_world_stays_frozen_and_players_wake_their_region() {
    let mut s = Sim::new(5, 1).unwrap();
    let h0 = s.grid.mat.clone();
    for _ in 0..30 {
        s.step();
    }
    assert_eq!(s.grid.mat, h0, "no active player: nothing updates");
    assert_eq!(s.grid.ran_chunks, 0);
    // A player far left activates only nearby chunks.
    push(&mut s, encode_join(1));
    push(&mut s, encode_pos(1, 0, 300 * PX, 230 * PX, 0));
    s.step();
    assert!(s.grid.ran_chunks > 0 && (s.grid.ran_chunks as usize) < s.grid.chunk_count() / 4);
    let active = |cx: usize, cy: usize| s.grid.active[cy * s.grid.cw + cx];
    assert!(active(4, 3) && !active(20, 3) && !active(4, 20));
    // Leave: frozen again.
    push(&mut s, encode_leave(1));
    s.step();
    s.step();
    assert_eq!(s.grid.ran_chunks, 0);
}

#[test]
fn entities_are_in_the_hash_and_snapshot_and_survive_a_restore() {
    let mut a = Sim::new(4, 1).unwrap();
    let h0 = a.state_hash();
    push(&mut a, encode_join(1));
    a.step();
    // Same tick number, different entity bytes -> different hash.
    let mut b = Sim::new(4, 1).unwrap();
    b.step();
    assert_ne!(a.state_hash(), b.state_hash());
    assert_ne!(h0, a.state_hash());
    let snap = snapshot::write(&a);
    assert_eq!(snap.len(), snapshot::size(&a));
    let mut r = snapshot::restore(&snap).unwrap();
    assert_eq!(r.players, a.players);
    assert_eq!(r.pickups, a.pickups);
    assert_eq!(r.state_hash(), a.state_hash());
}

/// D5 with entities: snapshot at several ticks (across joins, moves, a leave, a rejoin and pickups),
/// restore, continue to the end: every checkpoint hash must equal the uninterrupted run's.
#[test]
fn d5_snapshot_roundtrip_with_players_across_the_boundary() {
    let mut full = Sim::new(8, 1).unwrap();
    let mut want = vec![];
    for t in 1..=400u32 {
        for b in script(&full, t) {
            push(&mut full, b);
        }
        full.step();
        if t % 20 == 0 {
            want.push((t, full.state_hash()));
        }
    }
    assert!(!full.players.is_empty() && full.pickups.iter().any(|k| k.respawn_at > 0), "script must exercise entities");
    for &cut in &[2u32, 6, 40, 41, 89, 91, 100, 250] {
        let mut s = Sim::new(8, 1).unwrap();
        run_to(&mut s, 1, cut);
        let snap = snapshot::write(&s);
        assert_eq!(snap.len(), snapshot::size(&s));
        let mut r = snapshot::restore(&snap).unwrap();
        assert_eq!(r.state_hash(), s.state_hash(), "cut {cut}");
        let mut got = vec![];
        for t in cut + 1..=400 {
            for b in script(&r, t) {
                push(&mut r, b);
            }
            r.step();
            if t % 20 == 0 {
                got.push((t, r.state_hash()));
            }
        }
        let w: Vec<_> = want.iter().filter(|(t, _)| *t > cut).cloned().collect();
        assert_eq!(got, w, "cut at {cut}");
    }
}

/// D7 with players: sleeping on and off agree when players activate regions and move across chunk edges.
#[test]
fn d7_sleep_is_invisible_with_players() {
    let go = |sleep: bool| {
        let mut s = Sim::new(5, 1).unwrap();
        s.grid.sleep_enabled = sleep;
        let mut out = vec![];
        for t in 1..=700u32 {
            if t == 1 {
                push(&mut s, encode_join(1));
                push(&mut s, encode_join(2));
            }
            // Player 1 walks left to right through the surface; player 2 sits in a cave region.
            push(&mut s, encode_pos(1, 0, (300 + t as i32) * PX, 230 * PX, 0));
            push(&mut s, encode_pos(2, 0, 1500 * PX, 700 * PX, 1));
            if t == 400 {
                push(&mut s, encode_leave(2));
            }
            s.step();
            if t % 25 == 0 {
                out.push((t, s.state_hash()));
            }
        }
        out
    };
    assert_eq!(go(true), go(false));
}

#[test]
fn restore_rejects_hostile_entity_sections_and_v1_sandbox_snapshots_still_load() {
    let mut a = Sim::new(4, 1).unwrap();
    push(&mut a, encode_join(1));
    a.step();
    let snap = snapshot::write(&a);
    let elen = u32::from_le_bytes(snap[55..59].try_into().unwrap()) as usize;
    assert!(elen > 0);
    for bad in [u32::MAX, (elen + 1) as u32, 0, 0x7fff_ffff] {
        let mut b = snap.clone();
        b[55..59].copy_from_slice(&bad.to_le_bytes());
        assert!(snapshot::restore(&b).is_err(), "elen {bad}");
    }
    let mut b = snap.clone();
    b[59..63].copy_from_slice(&(MAX_PLAYERS as u32 + 1).to_le_bytes());
    assert!(snapshot::restore(&b).is_err());
    assert!(snapshot::restore(&snap[..snap.len() - 1]).is_err());

    // A v1 sandbox snapshot (version 1, entity length 0) restores and equals the v2 write apart from the version.
    let mut sb = Sim::new(9, 0).unwrap();
    push(&mut sb, encode_paint(1, 4, 100, 100, 300, 300, 8));
    sb.step();
    let mut v1 = snapshot::write(&sb);
    v1[4..6].copy_from_slice(&1u16.to_le_bytes());
    let mut r = snapshot::restore(&v1).expect("v1 restores");
    assert_eq!(r.state_hash(), sb.state_hash());
    // And a v1 game-world snapshot with a non-empty entity section is refused.
    let mut v1g = snap.clone();
    v1g[4..6].copy_from_slice(&1u16.to_le_bytes());
    assert!(snapshot::restore(&v1g).is_err());
}

#[test]
fn entity_and_event_views() {
    let mut s = Sim::new(2, 1).unwrap();
    push(&mut s, encode_join(5));
    s.step();
    let mut out = vec![0u8; 4 * sim::entities::ENTITY_BYTES];
    let n = sim::entities::write_view(&s.players, &s.pickups, s.tick, &mut out, 4);
    assert_eq!(n, 4);
    assert_eq!(out[0], sim::entities::ENT_PLAYER);
    assert_eq!(u32::from_le_bytes(out[1..5].try_into().unwrap()), 5);
    assert_eq!(out[sim::entities::ENTITY_BYTES], sim::entities::ENT_PICKUP);
}

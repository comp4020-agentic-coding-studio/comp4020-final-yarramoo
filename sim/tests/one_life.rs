//! F4 commit 7 (D-160): one life, no respawn, and the round-end loss event.
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::{encode_join, encode_pos};
use sim::sim::Sim;
use sim::tuning::*;

const PX: i32 = POS_ONE;

fn room(players: &[u32]) -> Sim {
    let mut s = Sim::new(5, RoomConfig { size: 0, ..RoomConfig::survival() }).unwrap();
    s.enemies.clear();
    for &id in players {
        s.push_input(&encode_join(id));
    }
    s.step();
    s.round_started |= ROUND_RUNNING; // F6b: this test is about the running round, not the lobby (tests/lobby.rs)
    s
}

fn kill(s: &mut Sim, idx: usize) {
    let amount = s.players[idx].health;
    s.apply_damage(idx, amount, CAUSE_LAVA);
}

fn round_ends(s: &Sim) -> usize {
    s.events.iter().filter(|e| e.kind == EV_ROUND_END).count()
}

#[test]
fn a_dead_player_never_respawns_with_death_one_but_does_with_death_zero() {
    let mut s = room(&[1, 2]);
    kill(&mut s, 0);
    assert_eq!(s.players[0].dead_until, u32::MAX);
    for _ in 0..(DEATH_TICKS * 3) {
        s.step();
    }
    assert_eq!(s.players[0].health, 0, "still dead long after any respawn delay");
    assert_eq!(s.players[0].life, 0);
    // a rejoin does not revive, and Pos is ignored
    s.push_input(&encode_join(1));
    s.push_input(&encode_pos(1, 0, 10 * PX, 10 * PX, 0));
    s.step();
    assert_eq!(s.players[0].health, 0);
    // death 0 still respawns
    let mut p = Sim::new(5, RoomConfig { size: 0, ..RoomConfig::caves_pvp() }).unwrap();
    p.push_input(&encode_join(1));
    p.step();
    p.apply_damage(0, 100, CAUSE_LAVA);
    assert_ne!(p.players[0].dead_until, u32::MAX);
    for _ in 0..(DEATH_TICKS + 5) {
        p.step();
    }
    assert!(p.players[0].health > 0);
}

#[test]
fn the_round_is_lost_exactly_once_when_a_solo_player_dies() {
    let mut s = room(&[1]);
    let mut n = 0;
    for t in 0..400 {
        if t == 10 {
            kill(&mut s, 0);
        }
        s.step();
        n += round_ends(&s);
    }
    assert_eq!(n, 1);
    assert_eq!(s.round_over, 1);
}

#[test]
fn with_two_players_the_round_ends_only_when_the_second_dies() {
    let mut s = room(&[1, 2]);
    kill(&mut s, 0);
    let mut n = 0;
    for _ in 0..30 {
        s.step();
        n += round_ends(&s);
    }
    assert_eq!((n, s.round_over), (0, 0), "one still alive");
    kill(&mut s, 1);
    for _ in 0..30 {
        s.step();
        n += round_ends(&s);
    }
    assert_eq!((n, s.round_over), (1, 1));
}

#[test]
fn the_loss_event_carries_a_zero_and_nothing_fires_in_other_rooms_or_before_anyone_joins() {
    let mut s2 = room(&[1]);
    kill(&mut s2, 0);
    s2.step();
    assert_eq!(s2.round_over, 1);
    let ev = s2.events.iter().find(|e| e.kind == EV_ROUND_END).copied().unwrap();
    assert_eq!((ev.a, ev.player), (0, 0), "a = 0 is a loss");
    // an empty round does not end
    let mut e = room(&[]);
    for _ in 0..50 {
        e.step();
        assert_eq!(round_ends(&e), 0);
    }
    // Deathmatch (round 0) never ends
    let mut d = Sim::new(5, RoomConfig { size: 0, ..RoomConfig::caves_pvp() }).unwrap();
    d.push_input(&encode_join(1));
    d.step();
    d.apply_damage(0, 100, CAUSE_LAVA);
    for _ in 0..20 {
        d.step();
        assert_eq!(round_ends(&d), 0);
    }
}

#[test]
fn the_ended_round_stops_the_enemies_and_survives_a_snapshot() {
    let mut s = room(&[1]);
    s.enemies = vec![Enemy::new(0, ENEMY_SLIME, s.players[0].x + 20 * PX, s.players[0].y - 30 * PX)];
    kill(&mut s, 0);
    s.step();
    assert_eq!(s.round_over, 1);
    let before = s.enemies.clone();
    for _ in 0..30 {
        s.step();
    }
    assert_eq!(s.enemies, before, "frozen after the round");
    let snap = sim::snapshot::write(&s);
    let r = sim::snapshot::restore(&snap).unwrap();
    assert_eq!(r.round_over, 1);
}

// ---- fix pass: S3, S2 (D-161), S4, S1 -------------------------------------------------------------------

use sim::input::encode_leave;

#[test]
fn a_living_player_who_disconnects_keeps_the_round_alive() {
    let mut s = room(&[1, 2]);
    kill(&mut s, 0);
    s.push_input(&encode_leave(2));
    for _ in 0..30 {
        s.step();
    }
    assert_eq!(s.round_over, 0, "dead A, alive B who left: no loss");
    // B dying later (after rejoining) ends it; and everyone dead ends it even if some left
    s.push_input(&encode_join(2));
    s.step();
    kill(&mut s, 1);
    s.step();
    assert_eq!((s.round_over, s.round_result), (1, 0));
}

#[test]
fn a_late_joiner_spectates_once_the_round_has_started_or_ended() {
    // F6b (D-166): the round starts when the lobby countdown completes, not at the first kill or death. Before it, a
    // joiner is alive (a friend arriving in the lobby); a first kill or death alone no longer makes a late joiner dead.
    let mut s = room(&[1]);
    s.round_started = 0; // back to the lobby
    s.push_input(&encode_join(2));
    s.step();
    assert!(s.players[1].health > 0, "a friend joining in the lobby is alive");
    s.enemies = vec![Enemy::new(0, ENEMY_SLIME, s.players[0].x + 5 * PX, s.players[0].y)];
    s.enemies[0].hp = 1;
    s.damage_enemy(0, 1, 1);
    s.reap_enemies();
    assert_eq!(s.round_started, 0, "a kill no longer starts the round (D-161 replaced)");
    s.push_input(&encode_join(4));
    s.step();
    assert!(s.players.iter().find(|p| p.id == 4).unwrap().health > 0, "still the lobby");
    // once running: a joiner is dead
    s.round_started = ROUND_RUNNING;
    s.push_input(&encode_join(3));
    s.step();
    let p3 = s.players.iter().find(|p| p.id == 3).unwrap();
    assert_eq!((p3.health, p3.dead_until), (0, u32::MAX), "a joiner after the start spectates");
    // after round_over: dead; and an existing id rejoining is unchanged
    let mut s = room(&[1]);
    kill(&mut s, 0);
    s.step();
    assert_eq!(s.round_over, 1);
    s.push_input(&encode_join(5));
    s.step();
    assert_eq!(s.players.iter().find(|p| p.id == 5).unwrap().health, 0);
    // a Deathmatch room is unaffected
    let mut d = Sim::new(5, RoomConfig { size: 0, ..RoomConfig::caves_pvp() }).unwrap();
    d.push_input(&encode_join(1));
    d.step();
    d.apply_damage(0, 100, CAUSE_LAVA);
    d.push_input(&encode_join(2));
    d.step();
    assert!(d.players[1].health > 0);
}

#[test]
fn the_round_state_is_in_the_view_the_snapshot_and_the_hash() {
    let mut s = room(&[1]);
    kill(&mut s, 0);
    s.step();
    let mut out = vec![0u8; 100 * ENTITY_BYTES];
    let n = write_view(&s.players, &s.pickups, &s.projectiles, &s.bags, &s.enemies, &s.heals, s.round_tail(), true, s.tick, &mut out, 100);
    let o = &out[(n - 1) * ENTITY_BYTES..n * ENTITY_BYTES];
    assert_eq!((o[0], o[5], o[6], u16::from_le_bytes([o[15], o[16]]), o[17]), (ENT_ROUND, 1, 0, 1, 1));
    let h = s.state_hash();
    let r = sim::snapshot::restore(&sim::snapshot::write(&s)).unwrap();
    assert_eq!((r.round_over, r.round_started, r.round_result), (1, 1, 0));
    let mut r2 = sim::snapshot::restore(&sim::snapshot::write(&s)).unwrap();
    r2.round_started = 0;
    assert_ne!(r2.state_hash(), h);
}

#[test]
fn a_teammates_fire_bolt_earns_no_credit_for_a_later_lava_death_in_co_op() {
    let mut s = room(&[1, 2]);
    s.players[0].x = 100 * PX;
    // a projectile landing on player 2 is simulated through the helper path: call the public cast route
    s.players[1].last_hit_by = 0;
    let before = s.players[1].last_hit_by;
    s.projectiles.push(Projectile { owner: 1, spell: 4, cast_seq: 1, x: s.players[1].x * 16, y: (s.players[1].y - 5 * PX) * 16, vx: 0, vy: 0, age: 20 });
    for _ in 0..3 {
        s.step();
    }
    assert_eq!(s.players[1].last_hit_by, before, "no last-hitter credit from a teammate's bolt");
    assert_eq!(s.players[1].health, HEALTH_MAX);
}

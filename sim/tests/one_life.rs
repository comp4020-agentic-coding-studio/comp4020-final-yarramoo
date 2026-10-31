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

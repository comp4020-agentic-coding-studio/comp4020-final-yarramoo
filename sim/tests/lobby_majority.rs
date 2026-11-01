//! F6b fix pass (S2, S3): the majority timeout and the spawn reset at the start.
use sim::config::RoomConfig;
use sim::input::{encode_join, encode_leave, encode_pos, encode_ready};
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

fn real() -> Sim {
    Sim::new(1, RoomConfig::survival()).unwrap()
}
fn join(s: &mut Sim, id: u32) {
    s.push_input(&encode_join(id));
    s.step();
}
fn ready(s: &mut Sim, id: u32) {
    s.push_input(&encode_ready(id, 1));
}
fn run(s: &mut Sim, n: u32) {
    for _ in 0..n {
        s.step();
    }
}
fn running(s: &Sim) -> bool {
    s.round_started & ROUND_RUNNING != 0
}

/// Three players, two ready: a strict majority. Returns the sim just after the tick the second Ready applied.
fn two_of_three() -> Sim {
    let mut s = real();
    for id in 1..=3 {
        join(&mut s, id);
    }
    ready(&mut s, 1);
    ready(&mut s, 2);
    s.step();
    s
}

#[test]
fn majority_1799_ticks_is_not_started_and_1800_is() {
    let mut s = two_of_three();
    let begun = s.majority_since;
    assert_eq!(begun, s.tick - 1);
    while s.tick - begun <= LOBBY_MAJORITY_TICKS {
        assert!(!running(&s), "not started {} ticks in", s.tick - begun);
        s.step();
    }
    assert!(running(&s));
    // the step that ran at tick begun + 1800 started it
    assert_eq!(s.tick - 1, begun + LOBBY_MAJORITY_TICKS);
}

#[test]
fn the_unready_are_spectators_after_the_majority_start_and_the_ready_are_alive_at_spawn() {
    let mut s = two_of_three();
    // pre-position the ready players somewhere else
    s.push_input(&encode_pos(1, 0, 100 * POS_ONE, 100 * POS_ONE, 0));
    run(&mut s, LOBBY_MAJORITY_TICKS + 2);
    assert!(running(&s));
    let p3 = s.players.iter().find(|p| p.id == 3).unwrap();
    assert_eq!((p3.health, p3.dead_until), (0, u32::MAX), "the AFK player is a spectator");
    for id in [1, 2] {
        let p = s.players.iter().find(|p| p.id == id).unwrap();
        assert!(p.health > 0);
    }
    // not lost: two are alive
    assert_eq!(s.round_over, 0);
}

#[test]
fn the_short_rule_still_wins_when_everyone_readies_first() {
    let mut s = two_of_three();
    run(&mut s, 400);
    ready(&mut s, 3);
    s.step();
    let all = s.lobby_since;
    assert_ne!(all, LOBBY_IDLE);
    run(&mut s, LOBBY_COUNTDOWN_TICKS + 2);
    assert!(running(&s));
    assert!(s.tick < all + LOBBY_COUNTDOWN_TICKS + 5, "started by the 3 s rule, long before the 30 s one");
    assert!(s.players.iter().all(|p| p.health > 0), "everyone was ready: nobody becomes a spectator");
}

#[test]
fn losing_the_majority_resets_the_long_countdown() {
    let mut s = two_of_three();
    run(&mut s, 1000);
    s.push_input(&encode_ready(2, 0)); // 1 of 3: no majority
    s.step();
    assert_eq!(s.majority_since, LOBBY_IDLE);
    ready(&mut s, 2);
    s.step();
    let again = s.majority_since;
    assert_eq!(again, s.tick - 1);
    run(&mut s, LOBBY_MAJORITY_TICKS - 5);
    assert!(!running(&s), "1000 + 1795 ticks of majority in total, but it restarted");
}

#[test]
fn a_changed_player_count_resets_the_long_countdown() {
    let mut s = two_of_three();
    run(&mut s, 1000);
    join(&mut s, 4); // 2 of 4 is not a strict majority, and a join resets anyway
    assert_eq!(s.majority_since, LOBBY_IDLE);
    ready(&mut s, 3);
    s.step(); // 3 of 4 again
    assert_ne!(s.majority_since, LOBBY_IDLE);
    s.push_input(&encode_leave(4));
    s.step(); // 3 of 3: everyone ready
    assert_ne!(s.lobby_since, LOBBY_IDLE);
}

#[test]
fn one_of_two_is_not_a_strict_majority_and_never_starts() {
    let mut s = real();
    join(&mut s, 1);
    join(&mut s, 2);
    ready(&mut s, 1);
    run(&mut s, LOBBY_MAJORITY_TICKS * 2);
    assert!(!running(&s));
    assert_eq!(s.majority_since, LOBBY_IDLE);
}

#[test]
fn solo_uses_the_short_rule() {
    let mut s = real();
    join(&mut s, 1);
    ready(&mut s, 1);
    run(&mut s, LOBBY_COUNTDOWN_TICKS + 3);
    assert!(running(&s));
}

#[test]
fn at_the_start_every_living_player_is_back_at_their_spawn_point() {
    let mut s = real();
    join(&mut s, 1);
    let spawn = (s.players[0].x, s.players[0].y);
    s.push_input(&encode_pos(1, 0, 900 * POS_ONE, 700 * POS_ONE, 1));
    ready(&mut s, 1);
    run(&mut s, 20);
    assert_eq!(s.players[0].x, 900 * POS_ONE, "free movement in the lobby");
    run(&mut s, LOBBY_COUNTDOWN_TICKS);
    assert!(running(&s));
    let p = &s.players[0];
    assert_ne!((p.x, p.y), (900 * POS_ONE, 700 * POS_ONE));
    // a respawn bumps `life`, so a Pos still in flight from before the start cannot undo the reset
    assert_eq!(p.life, 1);
    // spawn_point's x has tick-keyed jitter, so only the surface row and the neighbourhood are fixed
    assert_eq!(p.y >> POS_SHIFT, spawn.1 >> POS_SHIFT);
    assert!(((p.x - spawn.0) >> POS_SHIFT).abs() < 128);
}

#[test]
fn d5_snapshot_mid_majority_countdown_continues_identically() {
    let mut s = two_of_three();
    run(&mut s, 500);
    let mut r = snapshot::restore(&snapshot::write(&s)).unwrap();
    assert_eq!(r.majority_since, s.majority_since);
    assert_eq!(r.state_hash(), s.state_hash());
    for _ in 0..(LOBBY_MAJORITY_TICKS - 450) {
        s.step();
        r.step();
    }
    assert!(running(&s) && running(&r));
    assert_eq!(s.state_hash(), r.state_hash());
}

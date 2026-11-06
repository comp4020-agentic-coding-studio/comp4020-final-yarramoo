//! F6b (D-166): the Survival ready-up lobby. Ready flags and the countdown are hashed sim state driven by inputs.
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::{encode_cast, encode_join, encode_leave, encode_ready};
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

/// A seed that rolls the Deep Mage (INT-2: the boss is chosen per seed; seed 1 rolls the Colossus).
const MAGE_SEED: u64 = 2;

const PX: i32 = POS_ONE;

/// Seed 1's real Survival world (not a synthetic box).
fn real() -> Sim {
    Sim::new(MAGE_SEED, RoomConfig::survival()).unwrap()
}

fn join(s: &mut Sim, id: u32) {
    s.push_input(&encode_join(id));
    s.step();
}

fn ready(s: &mut Sim, id: u32, r: u8) {
    s.push_input(&encode_ready(id, r));
}

fn started(s: &Sim) -> bool {
    s.round_running != 0
}

fn starts(s: &Sim) -> usize {
    s.events.iter().filter(|e| e.kind == EV_ROUND_START).count()
}

/// Step `n` ticks counting EV_ROUND_START events.
fn run(s: &mut Sim, n: u32) -> usize {
    let mut c = 0;
    for _ in 0..n {
        s.step();
        c += starts(s);
    }
    c
}

#[test]
fn a_new_survival_room_is_a_lobby() {
    let mut s = real();
    assert!(s.in_lobby());
    join(&mut s, 1);
    assert!(!started(&s));
    assert_eq!(s.players[0].ready, 0);
}

#[test]
fn in_the_lobby_enemies_do_not_step_nothing_hurts_and_casts_are_ignored() {
    let mut s = real();
    join(&mut s, 1);
    s.players[0].charges = [INFINITE; NUM_SPELLS];
    let before: Vec<_> = s.enemies.iter().map(|e| (e.x, e.y, e.hp, e.state, e.cooldown_until)).collect();
    // an enemy beside the player would normally bite
    let (px, py) = (s.players[0].x, s.players[0].y);
    s.enemies.push(Enemy::new(60000, ENEMY_SLIME, px, py));
    let n_before = s.enemies.len();
    s.push_input(&encode_cast(1, 4, 0, 1));
    for _ in 0..120 {
        s.step();
    }
    assert_eq!(s.players[0].health, HEALTH_MAX, "no damage in the lobby");
    assert!(s.projectiles.is_empty(), "the cast was ignored");
    assert_eq!(s.events.iter().filter(|e| e.kind == EV_CAST).count(), 0);
    assert_eq!(s.players[0].charges, [INFINITE; NUM_SPELLS]);
    let after: Vec<_> = s.enemies.iter().take(n_before - 1).map(|e| (e.x, e.y, e.hp, e.state, e.cooldown_until)).collect();
    assert_eq!(before, after, "enemies did not step");
    assert_eq!((s.enemies[n_before - 1].x, s.enemies[n_before - 1].y), (px, py));
    // a direct damage call is also refused
    s.apply_damage(0, 100, CAUSE_LAVA);
    assert_eq!(s.players[0].health, HEALTH_MAX);
}

#[test]
fn countdown_179_ticks_is_not_started_180_is() {
    let mut s = real();
    join(&mut s, 1);
    ready(&mut s, 1, 1);
    s.step(); // the tick the input applies: the countdown begins here (lobby_since = this tick)
    let begun = s.tick - 1;
    assert_eq!(s.lobby_since, begun);
    let mut c = 0;
    while s.tick - begun <= LOBBY_COUNTDOWN_TICKS {
        assert!(!started(&s), "not started after {} ticks", s.tick - begun);
        s.step();
        c += starts(&s);
    }
    // the step that applied `tick == begun + 180` just ran
    assert!(started(&s));
    assert_eq!(c, 1);
    assert_eq!(s.lobby_since, LOBBY_IDLE);
}

#[test]
fn the_start_happens_on_exactly_the_180th_tick_after_the_last_ready() {
    let mut s = real();
    join(&mut s, 1);
    join(&mut s, 2);
    ready(&mut s, 1, 1);
    s.step();
    ready(&mut s, 2, 1);
    s.step();
    let begun = s.lobby_since;
    assert_eq!(begun, s.tick - 1);
    let mut start_tick = None;
    for _ in 0..400 {
        s.step();
        if starts(&s) == 1 {
            start_tick = Some(s.tick - 1);
        }
    }
    assert_eq!(start_tick, Some(begun + LOBBY_COUNTDOWN_TICKS), "the step that ran at tick begun+180 started the round");
}

#[test]
fn an_unready_at_tick_100_resets_the_countdown() {
    let mut s = real();
    join(&mut s, 1);
    ready(&mut s, 1, 1);
    run(&mut s, 100);
    ready(&mut s, 1, 0);
    run(&mut s, 1);
    assert_eq!(s.lobby_since, LOBBY_IDLE);
    ready(&mut s, 1, 1);
    s.step();
    let again = s.lobby_since;
    let c = run(&mut s, LOBBY_COUNTDOWN_TICKS - 5);
    assert_eq!((started(&s), c), (false, 0), "100 + 175 ticks all-ready in total, but the count restarted");
    let c = run(&mut s, 10) + c;
    assert!(started(&s));
    assert_eq!(c, 1);
    assert!(s.tick > again + LOBBY_COUNTDOWN_TICKS);
}

#[test]
fn a_new_joiner_resets_the_countdown() {
    let mut s = real();
    join(&mut s, 1);
    ready(&mut s, 1, 1);
    run(&mut s, 150);
    assert_ne!(s.lobby_since, LOBBY_IDLE);
    join(&mut s, 2);
    assert_eq!(s.lobby_since, LOBBY_IDLE);
    assert_eq!(run(&mut s, 100), 0, "player 2 is not ready");
    assert!(!started(&s));
    ready(&mut s, 2, 1);
    assert_eq!(run(&mut s, 170), 0);
    assert_eq!(run(&mut s, 20), 1);
}

#[test]
fn a_rejoin_also_resets_readiness_and_the_countdown() {
    let mut s = real();
    join(&mut s, 1);
    ready(&mut s, 1, 1);
    run(&mut s, 50);
    join(&mut s, 1);
    assert_eq!(s.players[0].ready, 0);
    assert_eq!(s.lobby_since, LOBBY_IDLE);
}

#[test]
fn a_leaver_who_was_the_only_not_ready_player_lets_the_countdown_begin() {
    let mut s = real();
    join(&mut s, 1);
    join(&mut s, 2);
    ready(&mut s, 1, 1);
    run(&mut s, 30);
    assert_eq!(s.lobby_since, LOBBY_IDLE);
    s.push_input(&encode_leave(2));
    s.step();
    assert_ne!(s.lobby_since, LOBBY_IDLE, "only the ready player is left");
    assert_eq!(run(&mut s, LOBBY_COUNTDOWN_TICKS + 1), 1);
}

#[test]
fn a_leaver_mid_countdown_restarts_it() {
    let mut s = real();
    join(&mut s, 1);
    join(&mut s, 2);
    ready(&mut s, 1, 1);
    ready(&mut s, 2, 1);
    run(&mut s, 120);
    s.push_input(&encode_leave(2));
    s.step();
    // the active count changed: the countdown restarts from this tick
    let begun = s.lobby_since;
    assert_eq!(begun, s.tick - 1);
    assert_eq!(run(&mut s, LOBBY_COUNTDOWN_TICKS - 2), 0);
    assert_eq!(run(&mut s, 5), 1);
}

#[test]
fn zero_players_never_start_a_round() {
    let mut s = real();
    assert_eq!(run(&mut s, 400), 0);
    join(&mut s, 1);
    s.push_input(&encode_leave(1));
    s.step();
    assert_eq!(run(&mut s, 400), 0);
    assert!(!started(&s));
}

#[test]
fn ready_from_an_unjoined_or_inactive_player_does_nothing() {
    let mut s = real();
    ready(&mut s, 9, 1);
    join(&mut s, 1);
    s.push_input(&encode_leave(1));
    s.step();
    ready(&mut s, 1, 1);
    s.step();
    assert_eq!(s.players[0].ready, 0);
}

#[test]
fn a_solo_player_can_start_alone() {
    let mut s = real();
    join(&mut s, 1);
    ready(&mut s, 1, 1);
    assert_eq!(run(&mut s, 400), 1);
}

#[test]
fn ready_is_ignored_outside_survival_and_after_the_start() {
    let mut d = Sim::new(5, RoomConfig { size: 0, ..RoomConfig::caves_pvp() }).unwrap();
    join(&mut d, 1);
    ready(&mut d, 1, 1);
    d.step();
    assert_eq!(d.players[0].ready, 0);
    assert!(!d.in_lobby());
    let mut s = real();
    join(&mut s, 1);
    ready(&mut s, 1, 1);
    run(&mut s, 200);
    assert!(started(&s));
    ready(&mut s, 1, 0);
    s.step();
    assert_eq!(s.players[0].ready, 1, "ready no longer changes");
    assert!(started(&s));
}

#[test]
fn after_the_start_a_new_id_joins_dead_and_a_rejoin_keeps_its_state() {
    let mut s = real();
    join(&mut s, 1);
    ready(&mut s, 1, 1);
    run(&mut s, 200);
    assert!(started(&s));
    join(&mut s, 2);
    let p2 = s.players.iter().find(|p| p.id == 2).unwrap();
    assert_eq!((p2.health, p2.dead_until), (0, u32::MAX));
    s.players[0].health = 40;
    s.players[0].x = 123 * PX;
    s.push_input(&encode_leave(1));
    s.step();
    join(&mut s, 1);
    let p1 = &s.players[0];
    assert_eq!((p1.health, p1.x, p1.active), (40, 123 * PX, true));
    assert!(started(&s), "a rejoin never restarts a lobby");
}

#[test]
fn a_joiner_during_the_lobby_is_alive_and_the_start_event_fires_once() {
    let mut s = real();
    join(&mut s, 1);
    join(&mut s, 2);
    assert!(s.players.iter().all(|p| p.health > 0));
    ready(&mut s, 1, 1);
    ready(&mut s, 2, 1);
    assert_eq!(run(&mut s, 1000), 1);
}

#[test]
fn boss_killed_still_wins_the_round_after_a_lobby_start() {
    let mut s = real();
    s.enemies.retain(|e| e.kind == ENEMY_BOSS);
    join(&mut s, 1);
    ready(&mut s, 1, 1);
    run(&mut s, 200);
    assert!(started(&s));
    assert_eq!((s.round_running, s.boss_killed), (1, 0));
    let i = s.enemies.iter().position(|e| e.kind == ENEMY_BOSS).unwrap();
    s.enemies[i].hp = 1;
    s.damage_enemy(i, 1, 1);
    s.reap_enemies();
    assert_eq!((s.round_running, s.boss_killed), (1, 1));
    s.step();
    assert_eq!((s.round_over, s.round_result), (1, 1));
}

#[test]
fn a_first_kill_or_death_no_longer_starts_a_round_and_the_lobby_is_never_lost() {
    // in the lobby the last player cannot die, so the round cannot end
    let mut s = real();
    join(&mut s, 1);
    s.players[0].health = 0;
    s.step();
    assert_eq!(s.round_over, 0, "the lobby has no loss rule");
    assert!(!started(&s));
}

#[test]
fn d5_snapshot_round_trips_mid_lobby_and_mid_countdown() {
    let mut s = real();
    join(&mut s, 1);
    join(&mut s, 2);
    ready(&mut s, 1, 1);
    run(&mut s, 20);
    let mut a = snapshot::restore(&snapshot::write(&s)).unwrap();
    assert_eq!(a.state_hash(), s.state_hash());
    ready(&mut s, 2, 1);
    run(&mut s, 70);
    assert_ne!(s.lobby_since, LOBBY_IDLE);
    let mut b = snapshot::restore(&snapshot::write(&s)).unwrap();
    assert_eq!((b.lobby_since, b.players[0].ready, b.players[1].ready), (s.lobby_since, 1, 1));
    assert_eq!(b.state_hash(), s.state_hash());
    // both run on, and start on the same tick
    let (mut sc, mut bc) = (0, 0);
    for _ in 0..200 {
        s.step();
        b.step();
        sc += starts(&s);
        bc += starts(&b);
        assert_eq!(s.state_hash(), b.state_hash());
    }
    assert_eq!((sc, bc), (1, 1));
}

#[test]
fn d7_sleeping_is_invisible_through_the_lobby_and_the_start() {
    let play = |sleep: bool| {
        let mut s = real();
        s.grid.sleep_enabled = sleep;
        s.grid.wake_all();
        join(&mut s, 1);
        ready(&mut s, 1, 1);
        let mut hs = Vec::new();
        for t in 0..260 {
            s.step();
            if t % 20 == 0 {
                hs.push(s.state_hash());
            }
        }
        (hs, started(&s))
    };
    let (a, sa) = play(true);
    let (b, sb) = play(false);
    assert!(sa && sb);
    assert_eq!(a, b);
}

#[test]
fn hostile_snapshots_with_bad_phase_or_ready_values_are_refused() {
    let mut s = real();
    join(&mut s, 1);
    ready(&mut s, 1, 1);
    s.step();
    let good = snapshot::write(&s);
    assert!(snapshot::restore(&good).is_ok());
    let e = s.entity_bytes();
    // locate the entity section in the snapshot, then flip bytes inside it
    let at = good.windows(e.len()).position(|w| w == e.as_slice()).expect("entity bytes in the snapshot");
    // ready byte of player 0 is the last byte of its record (the record starts at offset 4)
    let ready_at = at + 4 + PLAYER_BYTES - 1;
    let mut b = good.clone();
    assert_eq!(b[ready_at], 1);
    b[ready_at] = 2;
    assert!(snapshot::restore(&b).is_err(), "ready 2");
    // round_running above 1
    let l = e.len();
    let mut b = good.clone();
    b[at + l - 11] = 2;
    assert!(snapshot::restore(&b).is_err(), "round_running 2");
    // round_over above 1
    let mut b = good.clone();
    b[at + l - 12] = 2;
    assert!(snapshot::restore(&b).is_err(), "round_over 2");
    // a countdown start that lies in the future of the snapshot tick, or while the round is running, is nonsense
    let mut b = good.clone();
    b[at + l - 8..at + l - 4].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(snapshot::restore(&b).is_ok(), "idle is a valid lobby_since");
    let mut b = good.clone();
    b[at + l - 11] = 1; // running, yet lobby_since still set
    assert!(snapshot::restore(&b).is_err(), "running with a live countdown");
}

#[test]
fn the_view_carries_the_phase_ready_flags_and_countdown() {
    let mut s = real();
    join(&mut s, 1);
    join(&mut s, 2);
    ready(&mut s, 2, 1);
    s.step();
    let view = |s: &Sim| {
        let mut out = vec![0u8; 400 * ENTITY_BYTES];
        let n = write_view(&s.players, &s.pickups, &s.projectiles, &s.bags, &s.enemies, &s.heals, s.round_tail(), true, s.tick, &mut out, 400);
        (0..n).map(|i| out[i * ENTITY_BYTES..(i + 1) * ENTITY_BYTES].to_vec()).collect::<Vec<_>>()
    };
    let v = view(&s);
    let round = v.iter().find(|o| o[0] == ENT_ROUND).unwrap();
    assert_eq!(i32::from_le_bytes(round[7..11].try_into().unwrap()), -1, "no countdown while player 1 is not ready");
    let flags: Vec<_> = v.iter().filter(|o| o[0] == ENT_READY).map(|o| (u32::from_le_bytes(o[1..5].try_into().unwrap()), o[5])).collect();
    assert_eq!(flags, vec![(1, 0), (2, 1)]);
    ready(&mut s, 1, 1);
    run(&mut s, 61);
    let v = view(&s);
    let round = v.iter().find(|o| o[0] == ENT_ROUND).unwrap();
    let left = i32::from_le_bytes(round[7..11].try_into().unwrap());
    assert!((100..=125).contains(&left), "about 120 ticks left, got {left}");
    run(&mut s, 200);
    let v = view(&s);
    assert!(v.iter().all(|o| o[0] != ENT_READY), "no ready records once running");
    assert_eq!(v.iter().find(|o| o[0] == ENT_ROUND).unwrap()[17] & 1, 1);
}

#[test]
fn hostile_snapshot_with_a_countdown_in_the_future_or_a_boss_bit_without_running_is_refused() {
    let mut s = real();
    join(&mut s, 1);
    ready(&mut s, 1, 1);
    s.step();
    let good = snapshot::write(&s);
    let e = s.entity_bytes();
    let at = good.windows(e.len()).position(|w| w == e.as_slice()).unwrap();
    let l = e.len();
    let tick = s.tick;
    // lobby_since later than the snapshot's tick (the very next step would start the round)
    let mut b = good.clone();
    b[at + l - 8..at + l - 4].copy_from_slice(&(tick + 5000).to_le_bytes());
    assert!(snapshot::restore(&b).is_err(), "lobby_since in the future");
    let mut b = good.clone();
    b[at + l - 4..at + l].copy_from_slice(&(tick + 5000).to_le_bytes());
    assert!(snapshot::restore(&b).is_err(), "majority_since in the future");
    // the boss bit without RUNNING
    let mut b = good.clone();
    b[at + l - 10] = 1;
    assert!(snapshot::restore(&b).is_err(), "boss bit while still in the lobby");
    // the same bytes with RUNNING set and the countdowns idle are fine
    let mut b = good.clone();
    b[at + l - 11] = 1;
    b[at + l - 10] = 1;
    b[at + l - 8..at + l].copy_from_slice(&[0xff; 8]);
    assert!(snapshot::restore(&b).is_ok());
}

#[test]
fn a_world_explosion_cannot_hurt_the_boss_in_the_lobby() {
    let mut s = real();
    join(&mut s, 1);
    let i = s.enemies.iter().position(|e| e.kind == ENEMY_BOSS).unwrap();
    let hp = s.enemies[i].hp;
    s.damage_enemy(i, 500, 0);
    s.reap_enemies();
    assert_eq!(s.enemies.iter().find(|e| e.kind == ENEMY_BOSS).map(|e| e.hp), Some(hp));
    assert_eq!(s.round_running, 0);
    // once running, the same call hurts
    s.round_running = 1;
    s.damage_enemy(i, 500, 0);
    assert_eq!(s.enemies[i].hp, hp - 500);
}

#[test]
fn a_leave_for_an_already_inactive_player_does_not_reset_the_countdown() {
    let mut s = real();
    join(&mut s, 1);
    join(&mut s, 2);
    s.push_input(&encode_leave(2));
    s.step();
    ready(&mut s, 1, 1);
    run(&mut s, 50);
    let begun = s.lobby_since;
    assert_ne!(begun, LOBBY_IDLE);
    s.push_input(&encode_leave(2)); // 2 is already inactive
    run(&mut s, 1);
    assert_eq!(s.lobby_since, begun, "the countdown carries on");
}

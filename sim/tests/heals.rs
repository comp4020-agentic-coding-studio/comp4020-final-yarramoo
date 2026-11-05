//! Brief E: heal drops from killed enemies. Drop rule, fall, pickup, expiry, cap, event, view, snapshot, sleep.
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::encode_join;
use sim::materials::*;
use sim::rng::{rng, SALT_HEAL_DROP};
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

/// Flat arena (air above y=200, rock below, x 300..700), player 1 at x=500, no generated enemies, round running.
fn arena() -> Sim {
    let mut s = Sim::new(5, RoomConfig::survival()).unwrap();
    s.enemies.clear();
    let w = s.grid.w;
    for y in 100..320 {
        for x in 300..700 {
            s.grid.mat[y * w + x] = if y < 200 { EMPTY } else { ROCK };
        }
    }
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
    s.push_input(&encode_join(1));
    s.push_input(&encode_join(2));
    s.step();
    s.round_running = 1;
    s.players[0].x = 500 * PX;
    s.players[0].y = 200 * PX; // feet line 200: standing on the rock, hitbox rows 190..=199
    s.players[1].x = 320 * PX;
    s.players[1].y = 200 * PX;
    s.events.clear();
    s
}

fn heal(x: u16, y: u16, expires_at: u32) -> Heal {
    Heal { x, y, amount: 25, expires_at }
}

fn dying(s: &mut Sim, kind: u8, x: i32) {
    let mut e = Enemy::new(0, kind, x * PX, 200 * PX);
    e.hp = 0;
    s.enemies = vec![e];
}

/// The documented draw, recomputed here from the enemy's cell.
fn passes(seed: u64, tick: u32, x: i32) -> bool {
    rng(seed, tick, x as u32, 200, SALT_HEAL_DROP) .is_multiple_of(HEAL_DROP_ONE_IN)
}

#[test]
fn a_normal_kill_drops_a_heal_exactly_when_the_counter_draw_passes() {
    let (mut yes, mut no) = (None, None);
    for t in 1000..1200u32 {
        if passes(5, t, 500) {
            yes.get_or_insert(t);
        } else {
            no.get_or_insert(t);
        }
    }
    let (yes, no) = (yes.expect("a passing tick"), no.expect("a failing tick"));
    for (tick, drops) in [(yes, true), (no, false)] {
        let mut s = arena();
        s.tick = tick;
        dying(&mut s, ENEMY_SLIME, 500);
        s.reap_enemies();
        assert_eq!(s.heals.len(), usize::from(drops), "tick {tick}");
        if drops {
            let h = &s.heals[0];
            assert_eq!((h.x, h.amount, h.expires_at), (500, HEAL_AMOUNT, tick + HEAL_LIFETIME));
        }
    }
    // about one in three over many draws
    let n = (0..3000u32).filter(|&t| passes(5, t, 500)).count();
    assert!((800..1200).contains(&n), "{n}");
}

#[test]
fn the_boss_always_drops_one() {
    for t in 1000..1040u32 {
        let mut s = arena();
        s.tick = t;
        dying(&mut s, ENEMY_BOSS, 500);
        s.reap_enemies();
        assert_eq!(s.heals.len(), 1, "tick {t}");
    }
}

#[test]
fn rooms_without_enemies_never_drop() {
    let mut s = Sim::new(5, RoomConfig::caves_pvp()).unwrap();
    for t in 1000..1040u32 {
        s.tick = t;
        dying(&mut s, ENEMY_BOSS, 500);
        s.reap_enemies();
    }
    assert!(s.heals.is_empty());
}

#[test]
fn a_hurt_player_takes_it_capped_and_the_heal_is_gone() {
    let mut s = arena();
    s.players[0].health = 60;
    s.heals = vec![heal(500, 195, 99_999)];
    s.step();
    assert_eq!(s.players[0].health, 85);
    assert!(s.heals.is_empty());
    let ev: Vec<_> = s.events.iter().filter(|e| e.kind == EV_HEAL).collect();
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0].player, ev[0].a), (1, 25));
    // capped at HEALTH_MAX, and the event reports what was actually gained
    s.players[0].health = 90;
    s.heals = vec![heal(500, 195, 99_999)];
    s.events.clear();
    s.step();
    assert_eq!(s.players[0].health, HEALTH_MAX);
    assert_eq!(s.events.iter().find(|e| e.kind == EV_HEAL).unwrap().a, 10);
}

#[test]
fn a_full_health_player_leaves_it_for_a_teammate() {
    let mut s = arena();
    s.heals = vec![heal(500, 195, 99_999)];
    for _ in 0..10 {
        s.step();
    }
    assert_eq!(s.heals.len(), 1, "full health leaves it");
    s.players[0].health = 50;
    s.step();
    assert!(s.heals.is_empty());
    assert_eq!(s.players[0].health, 75);
}

#[test]
fn a_dead_player_cannot_take_it() {
    let mut s = arena();
    s.apply_damage(0, 100, CAUSE_LAVA);
    s.heals = vec![heal(500, 195, 99_999)];
    for _ in 0..5 {
        s.step();
    }
    assert_eq!(s.players[0].health, 0);
    assert_eq!(s.heals.len(), 1);
}

#[test]
fn it_falls_through_empty_space_stops_on_ground_and_expires() {
    let mut s = arena();
    s.heals = vec![heal(400, 120, 200)];
    s.step();
    assert_eq!(s.heals[0].y, 121);
    for _ in 0..100 {
        s.step();
    }
    assert_eq!(s.heals[0].y, 199, "rests on the rock");
    while s.tick < 199 {
        s.step();
    }
    assert_eq!(s.heals.len(), 1);
    s.step();
    s.step();
    assert!(s.heals.is_empty(), "expired at tick 200");
}

#[test]
fn at_most_max_heals_exist_and_the_oldest_goes_first() {
    let mut s = arena();
    for k in 0..(MAX_HEALS as i32 + 4) {
        s.drop_heal((350 + k, 150));
    }
    assert_eq!(s.heals.len(), MAX_HEALS);
    assert_eq!(s.heals[0].x, 354, "the first four were evicted");
    assert_eq!(s.heals[MAX_HEALS - 1].x, 350 + MAX_HEALS as u16 + 3);
}

#[test]
fn the_view_lists_a_heal() {
    let mut s = arena();
    s.heals = vec![heal(400, 150, 99_999)];
    let mut out = vec![0u8; 100 * ENTITY_BYTES];
    let n = write_view(&s.players, &s.pickups, &s.projectiles, &s.bags, &s.enemies, &s.heals, [0; ROUND_TAIL_BYTES], false, s.tick, &mut out, 100);
    let r = (0..n).map(|i| &out[i * ENTITY_BYTES..(i + 1) * ENTITY_BYTES]).find(|r| r[0] == ENT_HEAL).expect("a heal record");
    assert_eq!(i32::from_le_bytes(r[7..11].try_into().unwrap()), 400 * PX + PX / 2);
    assert_eq!(i32::from_le_bytes(r[11..15].try_into().unwrap()), 150 * PX + PX / 2);
    assert_eq!(u16::from_le_bytes([r[15], r[16]]), 25);
}

#[test]
fn format_is_thirteen_and_a_snapshot_with_heals_runs_on_identically() {
    assert_eq!(snapshot::FORMAT_VERSION, 14);
    let mut s = arena();
    // HEAL_LIFETIME from tick 0: the longest a real drop can live (a restore refuses more, review E).
    s.heals = vec![heal(400, 120, HEAL_LIFETIME), heal(450, 150, HEAL_LIFETIME)];
    for _ in 0..20 {
        s.step();
    }
    let snap = snapshot::write(&s);
    let mut r = snapshot::restore(&snap).unwrap();
    assert_eq!(r.heals, s.heals);
    assert_eq!(r.state_hash(), s.state_hash());
    for _ in 0..120 {
        s.step();
        r.step();
    }
    assert_eq!(r.heals, s.heals);
    assert_eq!(r.state_hash(), s.state_hash());
    assert_ne!(s.heals[0].y, 120);
}

#[test]
fn hostile_heal_bytes_fail_cleanly() {
    let mut s = arena();
    s.heals = vec![heal(400, 120, s.tick + HEAL_LIFETIME)];
    let good = snapshot::write(&s);
    assert!(snapshot::restore(&good).is_ok());
    for (x, y, amount) in [(u16::MAX, 5u16, 25u8), (5, u16::MAX, 25), (5, 5, 0), (5, 5, HEALTH_MAX + 1)] {
        let mut t = arena();
        t.heals = vec![Heal { x, y, amount, expires_at: 9 }];
        assert!(snapshot::restore(&snapshot::write(&t)).is_err(), "{x},{y},{amount}");
    }
    let mut t = arena();
    t.heals = (0..MAX_HEALS as u16 + 1).map(|i| heal(400 + i, 120, 9)).collect();
    assert!(snapshot::restore(&snapshot::write(&t)).is_err(), "over the cap");
}

fn sleep_run(sleep: bool) -> (Vec<u64>, Sim) {
    let mut s = Sim::new(11, RoomConfig::survival()).unwrap();
    s.grid.sleep_enabled = sleep;
    s.enemies.clear();
    s.push_input(&encode_join(1));
    s.step();
    s.round_running = 1;
    let (px, py) = (s.players[0].x >> POS_SHIFT, s.players[0].y >> POS_SHIFT);
    s.heals = vec![heal(100, 50, 99_999), heal((px + 30) as u16, (py - 120) as u16, 99_999)];
    let mut hs = vec![];
    for t in 1..=300u32 {
        s.step();
        if t % 10 == 0 {
            hs.push(s.state_hash());
        }
    }
    (hs, s)
}

#[test]
fn sleeping_is_invisible_to_falling_heals() {
    let (on, s_on) = sleep_run(true);
    let (off, s_off) = sleep_run(false);
    assert_eq!(on, off);
    assert_eq!(s_on.heals, s_off.heals);
    assert!(s_on.heals[0].y > 50 + 30, "the heal fell");
    assert!(s_on.grid.ran_chunks < s_off.grid.ran_chunks, "sleeping really skipped chunks in the sleeping run");
}

/// Review E should-fix 1: a heal dropped inside solid ground (an enemy dying in a wall) used to sit in the rock,
/// where no hitbox can reach it, for its whole lifetime, taking a slot. It now rises to the first open cell within
/// `HEAL_RISE_MAX`, and is not dropped at all if there is none (buried deep).
#[test]
fn a_heal_dropped_in_rock_rises_to_open_air_or_is_not_dropped() {
    let mut s = arena();
    // Rock from y = 200 down. A drop at y = 202 is two cells into the rock: it must come out at y = 199.
    s.drop_heal((450, 202));
    assert_eq!(s.heals.len(), 1);
    assert_eq!((s.heals[0].x, s.heals[0].y), (450, 199), "the heal should sit in the first open cell above the rock");
    // Deep inside the rock, further than HEAL_RISE_MAX from any open cell: nothing is dropped.
    let mut t = arena();
    t.drop_heal((450, 200 + HEAL_RISE_MAX as i32 + 20));
    assert!(t.heals.is_empty(), "a buried heal must not take a slot");
    // In open air it lands where it was dropped.
    let mut u = arena();
    u.drop_heal((450, 150));
    assert_eq!((u.heals[0].x, u.heals[0].y), (450, 150));
}

/// Review E note: decode refuses heals in a room without enemies (the sandbox), and a heal past its lifetime cap.
#[test]
fn decode_refuses_heals_without_enemies_and_immortal_heals() {
    let mut t = arena();
    t.heals = vec![heal(400, 120, t.tick.wrapping_add(HEAL_LIFETIME) + 10_000)];
    assert!(snapshot::restore(&snapshot::write(&t)).is_err(), "expires_at beyond tick + HEAL_LIFETIME must be refused");
    let mut c = Sim::new(5, RoomConfig::caves_pvp()).unwrap();
    c.heals = vec![heal(100, 100, 50)];
    assert!(snapshot::restore(&snapshot::write(&c)).is_err(), "heals in a room without enemies must be refused");
}

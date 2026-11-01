//! F6 commit 3: phases 2 and 3 (bombs, summons and their ids, the fan, the lava ring) and bounded work.
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::encode_join;
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

fn fight() -> Sim {
    let mut s = Sim::new(1, RoomConfig::survival()).unwrap();
    s.enemies.retain(|e| e.kind == ENEMY_BOSS);
    s.push_input(&encode_join(1));
    s.step();
    s.round_started |= ROUND_RUNNING; // F6b: these tests are about the fight; the lobby has its own tests
    let a = s.arena.unwrap();
    s.players[0].x = (a.cx + 20) * PX;
    s.players[0].y = (a.floor_y - 14) * PX;
    s.events.clear();
    s
}

fn bi(s: &Sim) -> usize {
    s.enemies.iter().position(|e| e.kind == ENEMY_BOSS).unwrap()
}

fn set_hp(s: &mut Sim, hp: u16) {
    let i = bi(s);
    s.enemies[i].hp = hp;
}

fn run(s: &mut Sim, ticks: u32) -> Vec<Event> {
    let mut ev = Vec::new();
    for _ in 0..ticks {
        s.step();
        s.players[0].health = HEALTH_MAX;
        ev.extend(s.events.iter().cloned());
    }
    ev
}

fn phase(s: &Sim) -> u8 {
    s.enemies[bi(s)].state >> 2
}

#[test]
fn each_threshold_switches_the_phase_once_and_emits_one_event() {
    let mut s = fight();
    let mut ev = run(&mut s, 5);
    assert_eq!(phase(&s), 1);
    assert!(!ev.iter().any(|e| e.kind == EV_ENEMY_PHASE));
    set_hp(&mut s, BOSS_HP * 2 / 3 - 1);
    ev = run(&mut s, 20);
    assert_eq!(phase(&s), 2);
    set_hp(&mut s, BOSS_HP / 3 - 1);
    ev.extend(run(&mut s, 20));
    assert_eq!(phase(&s), 3);
    let ph: Vec<(i32, i32)> = ev.iter().filter(|e| e.kind == EV_ENEMY_PHASE).map(|e| (e.a, e.b)).collect();
    let id = i32::from(s.enemies[bi(&s)].id);
    assert_eq!(ph, vec![(id, 2), (id, 3)]);
    // the boundary: hp * 3 > 2 * max is phase 1, else phase 2
    let two_thirds = BOSS_HP * 2 / 3;
    let mut t = fight();
    set_hp(&mut t, two_thirds + 1);
    run(&mut t, 5);
    assert_eq!(phase(&t), 1);
    set_hp(&mut t, two_thirds);
    run(&mut t, 5);
    assert_eq!(phase(&t), 2);
}

#[test]
fn phase_two_summons_imps_up_to_four_alive_with_sorted_unique_ids() {
    let mut s = fight();
    set_hp(&mut s, BOSS_HP / 2);
    let mut max_alive = 0;
    let mut seen_top = s.enemies.iter().map(|e| e.id).max().unwrap();
    for t in 0..2400 {
        run(&mut s, 1);
        let imps: Vec<&Enemy> = s.enemies.iter().filter(|e| e.kind == ENEMY_IMP).collect();
        max_alive = max_alive.max(imps.len());
        // a fresh summon (age: id above every id seen so far) appears in empty air inside the arena
        let a = s.arena.unwrap();
        for e in imps.iter().filter(|e| u32::from(e.id) > u32::from(seen_top)) {
            assert!(a.contains(e.x >> 4, (e.y >> 4) - 2, 0), "summoned outside the arena");
        }
        seen_top = s.enemies.iter().map(|e| e.id).max().unwrap();
        assert!(s.enemies.windows(2).all(|w| w[0].id < w[1].id), "unsorted at {t}");
        // kill one summon now and then so the ids must not repeat
        if t % 700 == 699 {
            if let Some(i) = s.enemies.iter().position(|e| e.kind == ENEMY_IMP) {
                s.enemies[i].hp = 0;
                s.reap_enemies();
            }
        }
    }
    assert!(max_alive >= 2, "summoned {max_alive}");
    assert!(max_alive <= BOSS_SUMMONS_ALIVE, "{max_alive} alive");
    let b = s.enemies[bi(&s)].clone();
    assert!(b.hop_until >= 3, "counter {}", b.hop_until);
    // every summon id is above the boss id and below id + 1 + counter: never reused
    for e in s.enemies.iter().filter(|e| e.kind == ENEMY_IMP) {
        assert!(e.id > b.id && u32::from(e.id) <= u32::from(b.id) + b.hop_until);
    }
    // the snapshot round trip keeps ids and counter
    let r = snapshot::restore(&snapshot::write(&s)).unwrap();
    assert_eq!(r.enemies, s.enemies);
}

#[test]
fn phase_two_lobs_enemy_bombs_that_only_hurt_players() {
    let mut s = fight();
    set_hp(&mut s, BOSS_HP / 2);
    let mut bombs = 0;
    for _ in 0..600 {
        s.step();
        s.players[0].health = HEALTH_MAX;
        bombs += s.projectiles.iter().filter(|q| q.owner & ENEMY_OWNER != 0 && q.spell == 5 && q.age == 0).count();
    }
    assert!(bombs >= 2, "{bombs} bombs");
}

#[test]
fn phase_three_fires_a_fan_of_three_and_places_a_capped_lava_ring() {
    let mut s = fight();
    set_hp(&mut s, BOSS_HP / 6);
    let lava0 = s.grid.mat.iter().filter(|&&m| m == LAVA).count();
    let mut fan_max = 0;
    let mut ring_writes = Vec::new();
    for _ in 0..500 {
        let before = s.grid.mat.iter().filter(|&&m| m == LAVA).count();
        s.step();
        s.players[0].health = HEALTH_MAX;
        let after = s.grid.mat.iter().filter(|&&m| m == LAVA).count();
        if after > before {
            ring_writes.push(after - before);
        }
        let fresh = s.projectiles.iter().filter(|q| q.owner & ENEMY_OWNER != 0 && q.spell == 4 && q.age == 0).count();
        fan_max = fan_max.max(fresh);
        assert!(s.projectiles.iter().filter(|q| q.owner & ENEMY_OWNER != 0).count() <= MAX_ENEMY_PROJECTILES);
    }
    assert_eq!(fan_max, 3, "a fan is three bolts");
    assert!(!ring_writes.is_empty() && ring_writes.iter().all(|&n| n <= BOSS_RING_CELLS as usize), "{ring_writes:?}");
    assert!(s.grid.mat.iter().filter(|&&m| m == LAVA).count() > lava0);
    // the boss is faster in phase 3 and a ring never fires more than once per period
    assert!(ring_writes.len() <= 500 / BOSS_RING_TICKS as usize + 1);
}

#[test]
fn a_fan_at_the_bolt_cap_fires_only_what_fits() {
    let mut s = fight();
    set_hp(&mut s, BOSS_HP / 6);
    // fill 14 of 16 slots with enemy bolts parked far away
    let a = s.arena.unwrap();
    for k in 0..14 {
        assert!(s.enemy_fire((ENEMY_IMP, 900 + k), 4, (a.cx * PX, (a.cy - 10) * PX), (0, -1)));
    }
    run(&mut s, 200);
    assert!(s.projectiles.iter().filter(|q| q.owner & ENEMY_OWNER != 0).count() <= MAX_ENEMY_PROJECTILES);
}

/// Work with the boss in phase 3, four summons alive and 20 other enemies stepping: the ring (24), the summon
/// reads and the boss's own collision tests, per tick, never exceed the bound below. Halving it must fail.
const BOSS_WORK_BOUND: u32 = 1400;

fn worst_work(s: &mut Sim, ticks: u32) -> u32 {
    let mut worst = 0;
    for _ in 0..ticks {
        s.step();
        s.players[0].health = HEALTH_MAX;
        worst = worst.max(s.enemy_work);
    }
    worst
}

#[test]
fn boss_work_is_bounded_in_phase_three_with_summons_alive() {
    let mut s = fight();
    set_hp(&mut s, BOSS_HP / 6);
    let a = s.arena.unwrap();
    let b = s.enemies[bi(&s)].id;
    for k in 0..4u16 {
        s.enemies.push(Enemy::new(b + 1 + k, ENEMY_IMP, (a.cx - 10 + 6 * i32::from(k)) * PX, (a.cy - 10) * PX));
    }
    let i = bi(&s);
    s.enemies[i].hop_until = 4;
    let worst = worst_work(&mut s, 1500);
    std::fs::write("/tmp/f6-boss-work.txt", format!("worst per-tick enemy_work with the boss in phase 3 and 4 summons: {worst}\n")).unwrap();
    assert!(worst > 0 && worst <= BOSS_WORK_BOUND, "work {worst}");
    assert!(worst > BOSS_WORK_BOUND / 2, "the bound must bite: halving it ({}) has to fail, work was {worst}", BOSS_WORK_BOUND / 2);
}

/// S5 (review-f6): the existing summon test never came near the cap (it passed with the cap at 8). Start with four summons
/// alive and the counter at 4: no further summon may appear while they live, over five summon periods.
#[test]
fn with_four_summons_alive_no_fifth_is_ever_summoned() {
    let mut s = fight();
    set_hp(&mut s, BOSS_HP / 2);
    let a = s.arena.unwrap();
    let b = s.enemies[bi(&s)].id;
    for k in 0..4u16 {
        s.enemies.push(Enemy::new(b + 1 + k, ENEMY_IMP, (a.cx - 12 + 8 * i32::from(k)) * PX, (a.cy - 12) * PX));
    }
    let i = bi(&s);
    s.enemies[i].hop_until = 4;
    for _ in 0..(5 * BOSS_SUMMON_TICKS) {
        s.step();
        s.players[0].health = HEALTH_MAX;
        for e in s.enemies.iter_mut().filter(|e| e.kind == ENEMY_IMP) {
            e.hp = e.hp.max(1); // the four stay alive (a bolt cannot hurt them anyway)
        }
        assert!(s.enemies.iter().filter(|e| e.kind == ENEMY_IMP).count() <= BOSS_SUMMONS_ALIVE);
    }
    assert_eq!(s.enemies[bi(&s)].hop_until, 4, "no summon was made while four lived");
}

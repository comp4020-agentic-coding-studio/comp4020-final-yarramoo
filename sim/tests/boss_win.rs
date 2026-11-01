//! F6 commit 4: the Survival win, end to end on seed 1's real terrain, plus D5 and D7 through a boss fight.
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::{encode_cast, encode_join};
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

fn fight() -> Sim {
    let mut s = Sim::new(1, RoomConfig::survival()).unwrap();
    s.enemies.retain(|e| e.kind == ENEMY_BOSS);
    s.push_input(&encode_join(1));
    s.step();
    let a = s.arena.unwrap();
    // the player floats beside the boss at its height; charges for every spell
    s.players[0].x = (a.cx + 14) * PX;
    s.players[0].y = (a.floor_y - 9) * PX;
    s.players[0].charges = [INFINITE; NUM_SPELLS];
    s.events.clear();
    s
}

fn boss_hp(s: &Sim) -> Option<u16> {
    s.enemies.iter().find(|e| e.kind == ENEMY_BOSS).map(|e| e.hp)
}

/// Real casts: Fire bolts aimed at the boss (it hovers near the centre); the player is held alive and in place.
fn kill_with_casts(s: &mut Sim, max_ticks: u32) -> u32 {
    let mut seq = 0u16;
    for t in 0..max_ticks {
        let Some(b) = s.enemies.iter().find(|e| e.kind == ENEMY_BOSS) else { return t };
        let p = &s.players[0];
        let (dx, dy) = (b.x - p.x, (b.y - 7 * PX) - (p.y - CHEST * PX));
        // angle: 0..65535 over a full turn, 0 = +x, counter-clockwise screen-down positive as the sim defines
        let ang = ((f64::atan2(f64::from(dy), f64::from(dx)) / std::f64::consts::TAU).rem_euclid(1.0) * 65536.0) as u16;
        if t % 15 == 0 {
            seq += 1;
            s.push_input(&encode_cast(1, 4, ang, seq));
        }
        s.step();
        s.players[0].health = HEALTH_MAX;
        s.players[0].x = (s.arena.unwrap().cx + 14) * PX;
        s.players[0].y = (s.arena.unwrap().floor_y - 9) * PX;
    }
    max_ticks
}

#[test]
fn a_scripted_player_kills_the_boss_with_real_casts_and_the_round_is_won_once() {
    let mut s = fight();
    let mut all = Vec::new();
    let mut seq = 0u16;
    let mut ended = None;
    for t in 0..12000u32 {
        if let Some(b) = s.enemies.iter().find(|e| e.kind == ENEMY_BOSS) {
            let p = &s.players[0];
            let (dx, dy) = (b.x - p.x, (b.y - 7 * PX) - (p.y - CHEST * PX));
            let ang = ((f64::atan2(f64::from(dy), f64::from(dx)) / std::f64::consts::TAU).rem_euclid(1.0) * 65536.0) as u16;
            if t % 15 == 0 {
                seq += 1;
                s.push_input(&encode_cast(1, 4, ang, seq));
            }
        }
        s.step();
        all.extend(s.events.iter().cloned());
        if s.round_over == 0 {
            s.players[0].health = HEALTH_MAX;
            let a = s.arena.unwrap();
            s.players[0].x = (a.cx + 14) * PX;
            s.players[0].y = (a.floor_y - 9) * PX;
        }
        if s.round_over != 0 && ended.is_none() {
            ended = Some(t);
        }
        if ended.is_some_and(|e| t > e + 600) {
            break;
        }
    }
    assert!(ended.is_some(), "the boss never died; hp left {:?}", boss_hp(&s));
    assert!(boss_hp(&s).is_none());
    let ends: Vec<_> = all.iter().filter(|e| e.kind == EV_ROUND_END).collect();
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0].a, 1);
    assert_eq!(s.round_result, 1);
    assert_eq!(all.iter().filter(|e| e.kind == EV_ENEMY_DEATH && e.c == i32::from(ENEMY_BOSS)).count(), 1);
    let death = all.iter().find(|e| e.kind == EV_ENEMY_DEATH && e.c == i32::from(ENEMY_BOSS)).unwrap();
    assert_eq!(death.player, 1, "kill credit goes to the player");
    // enemies stop afterwards: summoned imps no longer move
    let before: Vec<_> = s.enemies.iter().map(|e| (e.x, e.y)).collect();
    for _ in 0..60 {
        s.step();
    }
    assert_eq!(before, s.enemies.iter().map(|e| (e.x, e.y)).collect::<Vec<_>>());
    // a client that restores after the win sees it
    let r = snapshot::restore(&snapshot::write(&s)).unwrap();
    assert_eq!((r.round_over, r.round_result), (1, 1));
    let _ = kill_with_casts;
}

#[test]
fn the_boss_dying_on_the_tick_the_last_player_dies_counts_as_a_win() {
    let mut s = fight();
    let i = s.enemies.iter().position(|e| e.kind == ENEMY_BOSS).unwrap();
    s.enemies[i].hp = 1;
    s.players[0].health = 0;
    s.round_started = 0;
    // the boss takes its last hp from a world source on the same tick everyone is dead
    s.damage_enemy(i, 1, 0);
    s.reap_enemies();
    s.step();
    assert_eq!(s.round_over, 1);
    assert_eq!(s.round_result, 1, "a win on the same tick as the loss is a win");
    assert_eq!(s.events.iter().filter(|e| e.kind == EV_ROUND_END).count(), 1);
}

#[test]
fn losing_still_loses_while_the_boss_lives() {
    let mut s = fight();
    s.apply_damage(0, 255, CAUSE_ENEMY_BASE);
    for _ in 0..3 {
        s.step();
    }
    assert_eq!((s.round_over, s.round_result), (1, 0));
}

#[test]
fn d5_a_snapshot_mid_phase_three_with_ring_summons_and_bolts_continues_identically() {
    let mut s = fight();
    let i = s.enemies.iter().position(|e| e.kind == ENEMY_BOSS).unwrap();
    s.enemies[i].hp = BOSS_HP / 6;
    for _ in 0..700 {
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    // on to a tick with bolts in flight
    for _ in 0..200 {
        if s.projectiles.iter().any(|q| q.owner & ENEMY_OWNER != 0) {
            break;
        }
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    let (imps, bolts) = (s.enemies.iter().filter(|e| e.kind == ENEMY_IMP).count(), s.projectiles.iter().filter(|q| q.owner & ENEMY_OWNER != 0).count());
    assert!(imps > 0 && bolts > 0, "imps {imps} bolts {bolts} lava {}", s.grid.mat.iter().filter(|&&m| m == sim::materials::LAVA).count());
    let mut a = snapshot::restore(&snapshot::write(&s)).unwrap();
    assert_eq!(a.enemies, s.enemies);
    for _ in 0..400 {
        s.step();
        a.step();
        s.players[0].health = HEALTH_MAX;
        a.players[0].health = HEALTH_MAX;
    }
    assert_eq!(snapshot::write(&s), snapshot::write(&a), "diverged after the restore");
}

#[test]
fn d7_sleeping_is_invisible_through_all_three_phases() {
    let run = |frozen: bool| {
        let mut s = fight();
        for t in 0..1800u32 {
            if t == 300 || t == 900 {
                let i = s.enemies.iter().position(|e| e.kind == ENEMY_BOSS).unwrap();
                s.enemies[i].hp = if t == 300 { BOSS_HP / 2 } else { BOSS_HP / 6 };
            }
            if frozen {
                // no sleeping: every chunk is marked awake before every step
                for c in 0..s.grid.chunk_count() {
                    s.grid.mark_chunk(c);
                }
            }
            s.step();
            s.players[0].health = HEALTH_MAX;
        }
        (snapshot::write(&s), s.grid.mat.clone(), s.grid.aux.clone())
    };
    // enemies and the ring never depend on `grid.awake`; the grid itself may differ only through sleeping, which the
    // sim's own D7 pins, so compare the entity section (enemies, bolts, players)
    let (a, b) = (run(false), run(true));
    let ent = |v: &(Vec<u8>, Vec<u8>, Vec<u8>)| {
        let o = 4 + 2 + 32 + 8 + 16 + 4 + 2 + 2;
        let v = &v.0;
        let n = u32::from_le_bytes(v[o..o + 4].try_into().unwrap()) as usize;
        v[o + 4..o + 4 + n].to_vec()
    };
    assert_eq!(ent(&a), ent(&b), "entities differ with chunk sleeping disabled");
    assert!(a.1 == b.1 && a.2 == b.2, "the grid (mat or aux) differs with chunk sleeping disabled: the lava ring is sleep-dependent");
}

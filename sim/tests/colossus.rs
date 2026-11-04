//! X-boss: the Sand Colossus (size L Survival). Core behaviour, determinism, bounded work.
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::encode_join;
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

fn cfg_l() -> RoomConfig {
    RoomConfig { size: 2, ..RoomConfig::survival() }
}

fn col(s: &Sim) -> &Enemy {
    s.enemies.iter().find(|e| e.kind == ENEMY_COLOSSUS).expect("a colossus")
}

fn ci(s: &Sim) -> usize {
    s.enemies.iter().position(|e| e.kind == ENEMY_COLOSSUS).unwrap()
}

fn fight(dx: i32) -> Sim {
    let mut s = Sim::new(1, cfg_l()).unwrap();
    s.enemies.retain(|e| e.kind == ENEMY_COLOSSUS);
    s.push_input(&encode_join(1));
    s.step();
    s.round_running = 1;
    let a = s.arena.unwrap();
    s.players[0].x = (a.cx + dx) * PX;
    s.players[0].y = a.floor_y * PX;
    s.players[0].health = HEALTH_MAX;
    s
}

fn count(s: &Sim, m: u8) -> usize {
    s.grid.mat.iter().filter(|&&c| c == m).count()
}

#[test]
fn size_l_gets_the_colossus_and_other_sizes_the_mage() {
    let s = Sim::new(1, cfg_l()).unwrap();
    assert_eq!(s.enemies.iter().filter(|e| is_boss_kind(e.kind)).count(), 1);
    assert_eq!(col(&s).hp, COLOSSUS_HP);
    assert_eq!(ENEMY_STATS[usize::from(ENEMY_COLOSSUS)].hp, COLOSSUS_HP);
    let m = Sim::new(1, RoomConfig::survival()).unwrap();
    assert!(m.enemies.iter().any(|e| e.kind == ENEMY_BOSS) && !m.enemies.iter().any(|e| e.kind == ENEMY_COLOSSUS));
}

fn is_boss_kind(k: u8) -> bool {
    k == ENEMY_BOSS || k == ENEMY_COLOSSUS
}

#[test]
fn a_hit_sheds_sand_beside_it() {
    let mut s = fight(60);
    for _ in 0..3 {
        s.step();
    }
    let before = count(&s, SAND);
    let i = ci(&s);
    s.damage_enemy(i, 40, 1);
    s.step();
    let shed = count(&s, SAND) - before.min(count(&s, SAND));
    assert!(shed >= 10, "shed {shed}");
    assert!(col(&s).hp <= COLOSSUS_HP - 40 + 2);
}

#[test]
fn it_reforms_by_sucking_up_nearby_sand() {
    let mut s = fight(150);
    s.step();
    let i = ci(&s);
    s.enemies[i].hp = 300;
    s.enemies[i].summons = 300;
    let (cx, cy) = (s.enemies[i].x >> 4, (s.enemies[i].y >> 4) - 6);
    let w = s.grid.w;
    // a pile of sand on the arena floor beside it
    for k in 0..40 {
        let idx = (cy + 5) as usize * w + (cx + 7 + (k % 8)) as usize - (k / 8) as usize * w;
        if s.grid.mat[idx] == EMPTY {
            s.grid.set(idx, SAND, 0);
        }
    }
    let sand0 = count(&s, SAND);
    for _ in 0..200 {
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    assert!(col(&s).hp > 300, "hp {}", col(&s).hp);
    assert!(count(&s, SAND) < sand0);
}

#[test]
fn it_walks_toward_a_player() {
    let mut s = fight(50);
    let x0 = col(&s).x;
    for _ in 0..120 {
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    assert!(col(&s).x > x0, "{} {}", col(&s).x, x0);
}

#[test]
fn mid_fight_snapshot_restores_to_equal_hashes_and_work_is_bounded() {
    let mut s = fight(40);
    let mut peak = 0;
    for t in 0..400 {
        if t % 40 == 20 {
            let i = ci(&s);
            s.damage_enemy(i, 30, 1);
        }
        s.step();
        peak = peak.max(s.enemy_work);
        s.players[0].health = HEALTH_MAX;
    }
    assert!(col(&s).phase >= 2);
    let mut r = snapshot::restore(&snapshot::write(&s)).unwrap();
    assert_eq!(r.enemies, s.enemies);
    for _ in 0..300 {
        s.step();
        r.step();
        s.players[0].health = HEALTH_MAX;
        r.players[0].health = HEALTH_MAX;
        assert_eq!(s.state_hash(), r.state_hash());
    }
    // work: 24 shed + 361 scan + 10 shower + collision tests of the others, far under any per-tick budget
    assert!(peak < 2500, "peak {peak}"); // measured 1909 (collision tests of integrate and step-up dominate; the Colossus own cells are under 400)
}

#[test]
fn killing_it_wins_the_round() {
    let mut s = fight(30);
    let i = ci(&s);
    s.enemies[i].hp = 1;
    s.enemies[i].summons = 1;
    s.damage_enemy(i, 5, 1);
    s.step();
    assert_eq!(s.boss_killed, 1);
}

#[test]
fn bad_colossus_records_are_refused() {
    let bad = |f: &dyn Fn(&mut Sim)| {
        let mut t = fight(30);
        f(&mut t);
        snapshot::restore(&snapshot::write(&t)).is_err()
    };
    assert!(bad(&|t| { let i = ci(t); t.enemies[i].phase = 0; }));
    assert!(bad(&|t| { let i = ci(t); t.enemies[i].summons = COLOSSUS_HP + 1; }));
}

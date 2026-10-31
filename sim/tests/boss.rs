//! F6 commit 2: the boss kind, placement, stepping priority, leash and phase-1 attacks.
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::encode_join;
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

fn real() -> Sim {
    Sim::new(1, RoomConfig::survival()).unwrap()
}

fn boss(s: &Sim) -> &Enemy {
    s.enemies.iter().find(|e| e.kind == ENEMY_BOSS).expect("a boss")
}

/// The real arena emptied of other enemies, one player standing on the floor `dx` cells from the centre.
fn fight(dx: i32) -> Sim {
    let mut s = real();
    s.enemies.retain(|e| e.kind == ENEMY_BOSS);
    s.push_input(&encode_join(1));
    s.step();
    let a = s.arena.unwrap();
    s.players[0].x = (a.cx + dx) * PX;
    // in the air above the pillars (the player does not fall without a client), so the line is clear
    s.players[0].y = (a.floor_y - 14) * PX;
    s.players[0].health = HEALTH_MAX;
    s
}

#[test]
fn exactly_one_boss_at_the_arena_centre_in_survival_and_none_elsewhere() {
    for seed in 1..=4u64 {
        let s = Sim::new(seed, RoomConfig::survival()).unwrap();
        let bosses: Vec<_> = s.enemies.iter().filter(|e| e.kind == ENEMY_BOSS).collect();
        assert_eq!(bosses.len(), 1);
        let a = s.arena.unwrap();
        assert_eq!(bosses[0].x >> 4, a.cx);
        assert!(a.contains(bosses[0].x >> 4, (bosses[0].y >> 4) - 7, 0));
        assert_eq!(bosses[0].hp, BOSS_HP);
        assert!(s.enemies.windows(2).all(|w| w[0].id < w[1].id));
        // the 51 + 1 + 4 arithmetic at L stays inside the cap
        assert!(s.enemies.len() + BOSS_SUMMONS_ALIVE <= MAX_ENEMIES, "{} + 4 > {}", s.enemies.len(), MAX_ENEMIES);
    }
    let pvp = Sim::new(1, RoomConfig::caves_pvp()).unwrap();
    assert!(pvp.enemies.is_empty());
}

#[test]
fn the_boss_is_immune_to_fire_and_lava_and_shoves_on_contact() {
    let st = ENEMY_STATS[usize::from(ENEMY_BOSS)];
    assert_eq!((st.w, st.h, st.contact_damage), (11, 14, 20));
    assert!(st.immune & IMMUNE_FIRE != 0 && st.immune & IMMUNE_LAVA != 0);
    let mut s = fight(0);
    // stand inside the boss
    let b = boss(&s).clone();
    s.players[0].x = b.x;
    s.players[0].y = b.y - 2 * PX;
    let hp = s.players[0].health;
    s.step();
    assert!(s.players[0].health < hp, "contact must hurt");
    assert!(s.events.iter().any(|e| e.kind == EV_KNOCK));
}

#[test]
fn it_hovers_then_fires_fire_bolts_at_the_player_every_60_ticks() {
    let mut s = fight(20);
    let mut shots = Vec::new();
    for t in 0..400 {
        let before = s.projectiles.iter().filter(|q| q.owner & ENEMY_OWNER != 0).count();
        s.step();
        s.players[0].health = HEALTH_MAX;
        if s.projectiles.iter().filter(|q| q.owner & ENEMY_OWNER != 0).any(|q| q.age == 0) || s.projectiles.len() > before {
            shots.push(t);
        }
    }
    assert!(shots.len() >= 3, "fired {} times", shots.len());
    let gaps: Vec<i32> = shots.windows(2).map(|w| w[1] - w[0]).filter(|&g| g > 5).collect();
    assert!(gaps.iter().all(|&g| g % 60 == 0), "{gaps:?}");
    assert!(s.projectiles.iter().all(|q| q.owner & ENEMY_OWNER == 0 || q.spell == 4));
}

#[test]
fn knocked_hard_it_stays_inside_the_arena() {
    let mut s = fight(0);
    let a = s.arena.unwrap();
    for dir in [(128i16, 0i16), (-128, 0), (0, -128), (0, 128)] {
        for t in 0..300 {
            if t % 20 == 0 {
                let i = s.enemies.iter().position(|e| e.kind == ENEMY_BOSS).unwrap();
                s.enemies[i].vx = dir.0;
                s.enemies[i].vy = dir.1;
            }
            s.step();
            s.players[0].health = HEALTH_MAX;
            let b = boss(&s);
            assert!(a.contains(b.x >> 4, (b.y >> 4) - 7, 0), "left the arena at tick {t}: {:?} in {a:?}", (b.x >> 4, b.y >> 4));
        }
    }
}

#[test]
fn the_boss_still_steps_with_24_other_enemies_in_range() {
    let mut s = fight(0);
    let a = s.arena.unwrap();
    let b = boss(&s).clone();
    let mut v: Vec<Enemy> = (0..30u16).map(|i| Enemy::new(i, ENEMY_SLIME, (a.cx - 20 + i32::from(i % 10)) * PX, (a.floor_y - 1) * PX)).collect();
    let mut bb = b.clone();
    bb.id = 100;
    v.push(bb);
    s.enemies = v;
    let targets = s.alive_targets();
    let set = s.stepping_set(&targets);
    assert_eq!(set.len(), MAX_ENEMIES_STEPPED);
    assert!(set.iter().any(|&i| s.enemies[i].kind == ENEMY_BOSS), "boss starved");
    assert!(set.windows(2).all(|w| w[0] < w[1]));
}

#[test]
fn a_boss_snapshot_round_trips_and_hostile_ones_are_refused() {
    let mut s = fight(30);
    for _ in 0..50 {
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    let snap = snapshot::write(&s);
    let r = snapshot::restore(&snap).unwrap();
    assert_eq!(r.enemies, s.enemies);
    let bad = |f: &dyn Fn(&mut Sim)| {
        let mut t = fight(30);
        f(&mut t);
        snapshot::restore(&snapshot::write(&t)).is_err()
    };
    let bi = |t: &Sim| t.enemies.iter().position(|e| e.kind == ENEMY_BOSS).unwrap();
    assert!(bad(&|t| { let i = bi(t); t.enemies[i].state = 0; }), "phase 0");
    assert!(bad(&|t| { let i = bi(t); t.enemies[i].state = 4 << 2; }), "phase 4");
    assert!(bad(&|t| { let i = bi(t); t.enemies[i].hop_until = 100_000; }), "summon counter");
    assert!(bad(&|t| { let i = bi(t); t.enemies[i].hp = BOSS_HP + 1; }), "hp above max");
    assert!(bad(&|t| { t.enemies[0].kind = 9; }), "kind 9");
}

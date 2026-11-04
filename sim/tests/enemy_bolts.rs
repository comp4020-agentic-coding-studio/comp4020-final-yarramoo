//! F5 commit 1: enemy-owned projectiles (owner high bit + kind + id), through a test-only cast (`enemy_fire`).
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::{encode_cast, encode_join};
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::spells::{enemy_owner, enemy_owner_kind};
use sim::tuning::*;

const PX: i32 = POS_ONE;
const FIRE_BOLT: u8 = 4;

/// Flat arena, air above y=200, rock below (x 300..700); player 1 at x=500 standing on the floor; no enemies.
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
    s.step();
    s.round_running = 1; // F6b: this test is about the running round, not the lobby (tests/lobby.rs)
    s.players[0].x = 500 * PX;
    s.players[0].y = 200 * PX;
    s
}

/// Fire a bolt from the imp's mouth at (`x`, 195) cells straight to the right.
fn shoot_right(s: &mut Sim, from_x: i32) -> bool {
    s.enemy_fire((0, 7), FIRE_BOLT, (from_x * PX, 197 * PX), (1, 0))
}

#[test]
fn an_enemy_bolt_hurts_a_player_with_the_enemy_cause_and_credits_nobody() {
    let mut s = arena();
    s.players[0].last_hit_by = 0;
    assert!(shoot_right(&mut s, 470));
    // the tick of the impact: exactly the bolt's damage (the fire it lights burns the player later)
    for _ in 0..40 {
        s.step();
        if s.events.iter().any(|e| e.kind == EV_IMPACT) {
            break;
        }
    }
    let p = &s.players[0];
    assert_eq!(p.health, HEALTH_MAX - FIRE_BOLT_DAMAGE);
    assert_eq!(p.last_hit_by, 0, "an enemy bolt credits no player");
    assert!(s.projectiles.is_empty());
    // the hit is not a death; push the player to 1 hp and check the death event carries the cause and no killer
    let mut s = arena();
    s.players[0].health = 5;
    assert!(shoot_right(&mut s, 470));
    let mut d: Vec<Event> = Vec::new();
    for _ in 0..40 {
        s.step();
        d.extend(s.events.iter().copied().filter(|e| e.kind == EV_DEATH));
    }
    assert_eq!(d.len(), 1);
    assert_eq!((d[0].a, d[0].b), (0, i32::from(CAUSE_ENEMY_BASE)), "no killer, cause 40 + kind (the slime stands in until the imp exists)");
}

#[test]
fn an_enemy_bolt_never_hurts_an_enemy_or_stops_at_one() {
    let mut s = arena();
    s.players[0].x = 520 * PX;
    // a slime between the imp and the player, and the shooter's own body at the muzzle
    s.enemies = vec![Enemy::new(7, ENEMY_SLIME, 520 * PX, 200 * PX), Enemy::new(8, ENEMY_SLIME, 470 * PX, 200 * PX)];
    assert!(shoot_right(&mut s, 470));
    let mut impact_x = None;
    let before: Vec<u16> = s.enemies.iter().map(|e| e.hp).collect();
    for _ in 0..60 {
        s.step();
        assert!(s.events.iter().all(|e| e.kind != EV_ENEMY_HURT), "an enemy was hurt by an enemy bolt");
        if let Some(i) = s.events.iter().find(|e| e.kind == EV_IMPACT) {
            impact_x = Some(i.a);
            break;
        }
    }
    assert_eq!(s.enemies.iter().map(|e| e.hp).collect::<Vec<_>>(), before);
    // the bolt crossed both slimes (505, 490) and ended at the player's box (the impact reports the last free cell, x 517 for a box from 518); slime contact is separate
    assert!(impact_x.is_some_and(|x| (515..=522).contains(&x)), "{impact_x:?}");
}

#[test]
fn enemy_bolts_do_not_count_toward_a_players_projectile_cap_and_are_capped_themselves() {
    let mut s = arena();
    s.players[0].charges = [INFINITE; NUM_SPELLS];
    for k in 0..MAX_ENEMY_PROJECTILES {
        assert!(s.enemy_fire((0, k as u16), FIRE_BOLT, (320 * PX, 150 * PX), (1, 0)), "bolt {k}");
    }
    assert!(!s.enemy_fire((0, 99), FIRE_BOLT, (320 * PX, 150 * PX), (1, 0)), "the 17th enemy bolt is refused");
    // the player can still fill their own cap of 12
    for k in 0..MAX_PROJECTILES_PER_PLAYER {
        let spell = [0u8, 2, 3, 4, 5, 7, 8, 10][k % 8];
        s.push_input(&encode_cast(1, spell, 256, k as u16 + 1));
        for _ in 0..70 {
            s.step();
            if s.projectiles.iter().filter(|q| q.owner == 1).count() > k {
                break;
            }
        }
    }
    assert!(s.events.iter().all(|e| e.kind != EV_CAST_REJECTED || e.b != REJECT_FULL));
    assert_eq!(s.projectiles.iter().filter(|q| q.owner & ENEMY_OWNER != 0).count().min(MAX_ENEMY_PROJECTILES), s.projectiles.iter().filter(|q| q.owner & ENEMY_OWNER != 0).count());
}

#[test]
fn an_enemy_owner_never_equals_a_player_id() {
    let o = enemy_owner(2, 0xffff);
    assert_ne!(o & ENEMY_OWNER, 0);
    assert_eq!((enemy_owner_kind(o), o & 0xffff), (2, 0xffff));
    let mut s = arena();
    // a Join for an id with the owner bit is refused, so no player can ever be mistaken for an enemy
    s.push_input(&encode_join(ENEMY_OWNER | 5));
    s.step();
    assert!(s.players.iter().all(|p| p.id & ENEMY_OWNER == 0));
}

#[test]
fn an_enemy_bolt_survives_a_snapshot_round_trip_and_hostile_owners_are_refused() {
    let mut s = arena();
    assert!(shoot_right(&mut s, 400));
    s.step();
    let h = s.state_hash();
    let snap = snapshot::write(&s);
    let mut r = snapshot::restore(&snap).unwrap();
    assert_eq!(r.projectiles, s.projectiles);
    assert_eq!(r.state_hash(), h);
    for _ in 0..10 {
        s.step();
        r.step();
    }
    assert_eq!(r.state_hash(), s.state_hash());
    // an owner naming a kind that does not exist, or with reserved bits set, is a hostile section
    let pk = s.pickups.clone();
    let e = s.entity_bytes();
    let try_decode = |b: &[u8]| decode(b, &mut pk.clone(), 1024, 768);
    assert!(try_decode(&e).is_ok());
    let at = e.windows(4).position(|w| w == enemy_owner(0, 7).to_le_bytes()).unwrap();
    let mut bad = e.clone();
    bad[at..at + 4].copy_from_slice(&enemy_owner(200, 7).to_le_bytes());
    assert!(try_decode(&bad).is_err(), "unknown kind in the owner");
    let mut bad = e.clone();
    bad[at..at + 4].copy_from_slice(&(enemy_owner(0, 7) | 0x0100_0000).to_le_bytes());
    assert!(try_decode(&bad).is_err(), "reserved owner bits");
}

#[test]
fn an_enemy_bolt_does_not_hit_a_player_in_a_room_without_environment_damage() {
    // Creative has damage 0: an enemy bolt (environmental cause) must do nothing, like contact.
    let mut s = Sim::new(5, RoomConfig::creative()).unwrap();
    s.push_input(&encode_join(1));
    s.step();
    let (px, py) = (s.players[0].x, s.players[0].y);
    s.grid.mat.iter_mut().for_each(|m| *m = EMPTY);
    assert!(s.enemy_fire((0, 7), FIRE_BOLT, (px - 30 * PX, py - 5 * PX), (1, 0)));
    for _ in 0..40 {
        s.step();
    }
    assert_eq!(s.players[0].health, HEALTH_MAX);
}

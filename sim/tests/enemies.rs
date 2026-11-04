//! F4: enemy state, its snapshot section and the entities view (commit 2; the AI comes later).
use sim::config::RoomConfig;
use sim::entities::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

fn survival() -> Sim {
    Sim::new(5, RoomConfig::survival()).unwrap()
}

fn join(s: &mut Sim, id: u32) {
    s.push_input(&sim::input::encode_join(id));
}

#[test]
fn enemy_bytes_are_fixed_width_and_round_trip_through_a_snapshot() {
    assert_eq!(ENEMY_BYTES, 35);
    let mut s = survival();
    join(&mut s, 1);
    s.step();
    let mut hurt = Enemy::new(3, ENEMY_SLIME, 100 * 16, 200 * 16);
    hurt.hp = 7;
    hurt.vx = -5;
    hurt.vy = 9;
    hurt.cooldown_until = 99;
    hurt.last_hit_by = 1;
    hurt.last_hit_tick = 4;
    hurt.facing = 1;
    s.enemies = vec![Enemy::new(1, ENEMY_SLIME, 50 * 16, 60 * 16), hurt];
    s.round_over = 0;
    let h = s.state_hash();
    let snap = snapshot::write(&s);
    assert_eq!(snap.len(), snapshot::size(&s));
    let mut r = snapshot::restore(&snap).unwrap();
    assert_eq!(r.enemies, s.enemies);
    assert_eq!(r.state_hash(), h);
    // an enemy is in the hash
    let mut t = snapshot::restore(&snap).unwrap();
    t.enemies[0].x += 1;
    assert_ne!(t.state_hash(), h);
    // round_over is in the hash
    let mut u = snapshot::restore(&snap).unwrap();
    u.round_over = 1;
    assert_ne!(u.state_hash(), h);
}

#[test]
fn hostile_enemy_bytes_fail_cleanly() {
    let mut s = survival();
    join(&mut s, 1);
    s.step();
    s.enemies = vec![Enemy::new(1, ENEMY_SLIME, 50 * 16, 60 * 16)];
    let e = s.entity_bytes();
    let pk = s.pickups.clone();
    let try_decode = |b: &[u8]| decode(b, &mut pk.clone(), 1024, 768);
    assert!(try_decode(&e).is_ok());
    let at = e.len() - ROUND_TAIL_BYTES - 4 - ENEMY_BYTES - 4; // the (empty) heal count u32 sits between the enemies and the tail
    let mut c = e.clone();
    c[at..at + 4].copy_from_slice(&(MAX_ENEMIES as u32 + 1).to_le_bytes());
    assert!(try_decode(&c).is_err(), "count over the cap");
    c[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(try_decode(&c).is_err(), "huge count");
    c[at..at + 4].copy_from_slice(&2u32.to_le_bytes());
    assert!(try_decode(&c).is_err(), "count says 2, bytes hold 1");
    assert!(try_decode(&e[..e.len() - 1]).is_err(), "truncated");
    let mut t = e.clone();
    t.push(0);
    assert!(try_decode(&t).is_err(), "trailing byte");
    let mut k = e.clone();
    k[at + 4 + 2] = 9;
    assert!(try_decode(&k).is_err(), "unknown kind");
    let mut o = e.clone();
    o[at + 4 + 3..at + 4 + 7].copy_from_slice(&(5000 * 16i32).to_le_bytes());
    assert!(try_decode(&o).is_err(), "x outside the world");
    let mut z = e.clone();
    let hp_at = at + 4 + 2 + 1 + 4 + 4 + 2 + 2;
    z[hp_at..hp_at + 2].copy_from_slice(&0u16.to_le_bytes());
    assert!(try_decode(&z).is_err(), "dead enemy in state");
    let mut r = e.clone();
    let l = r.len();
    r[l - ROUND_TAIL_BYTES + 2] = 2; // round_result (the tail is over, started, result, lobby_since u32)
    assert!(try_decode(&r).is_err(), "round_over 2");
    // a full MAX_ENEMIES is accepted
    s.enemies = (0..MAX_ENEMIES as u16).map(|i| Enemy::new(i, ENEMY_SLIME, 50 * 16, 60 * 16)).collect();
    assert!(try_decode(&s.entity_bytes()).is_ok());
}

#[test]
fn a_snapshot_with_enemies_in_a_room_without_them_is_refused() {
    let mut s = survival();
    join(&mut s, 1);
    s.step();
    s.enemies = vec![Enemy::new(1, ENEMY_SLIME, 50 * 16, 60 * 16)];
    let mut snap = snapshot::write(&s);
    assert!(snapshot::restore(&snap).is_ok());
    // flip config byte 12 (enemies) to 0 in the header: the section is now hostile
    snap[46 + 12] = 0;
    assert!(snapshot::restore(&snap).is_err());
}

#[test]
fn the_entities_view_lists_enemies_after_the_players() {
    let mut s = survival();
    join(&mut s, 1);
    s.step();
    let mut e = Enemy::new(4, ENEMY_SLIME, 321, 654);
    e.hp = 11;
    e.state = 1;
    e.facing = 1;
    s.enemies = vec![e];
    let mut out = vec![0u8; 4000 * ENTITY_BYTES];
    let n = write_view(&s.players, &s.pickups, &s.projectiles, &s.bags, &s.enemies, &[], [0; ROUND_TAIL_BYTES], false, s.tick, &mut out, 4000);
    let o = &out[(n - 1) * ENTITY_BYTES..n * ENTITY_BYTES];
    assert_eq!(o[0], ENT_ENEMY);
    assert_eq!(u32::from_le_bytes(o[1..5].try_into().unwrap()), 4);
    assert_eq!((o[5], o[6]), (1, ENEMY_SLIME));
    assert_eq!(i32::from_le_bytes(o[7..11].try_into().unwrap()), 321);
    assert_eq!(u16::from_le_bytes(o[15..17].try_into().unwrap()), 11);
    assert_eq!(o[17], 1 | 128);
}

#[test]
fn the_old_world_hash_does_not_depend_on_enemies() {
    // A world with no enemies still round-trips with an empty enemy section.
    let mut s = Sim::new(5, 1).unwrap();
    let snap = snapshot::write(&s);
    let mut r = snapshot::restore(&snap).unwrap();
    assert!(r.enemies.is_empty());
    assert_eq!(r.state_hash(), s.state_hash());
}

// ---- generation (commit 3) ------------------------------------------------------------------------------

use sim::materials::*;

fn world(size: u8, enemies: u8, seed: u64) -> Sim {
    Sim::new(seed, RoomConfig { size, enemies, ..RoomConfig::survival() }).unwrap()
}

#[test]
fn slimes_exist_only_when_enemies_is_on() {
    for size in 0..=2u8 {
        assert!(world(size, 0, 3).enemies.is_empty(), "size {size} with enemies 0");
        assert!(!world(size, 1, 3).enemies.is_empty(), "size {size} with enemies 1");
    }
    // the old presets have none
    assert!(Sim::new(3, 1).unwrap().enemies.is_empty());
}

#[test]
fn slimes_stand_on_floors_out_of_liquid_and_clear_of_the_spawn_and_pickups() {
    for size in 0..=2u8 {
        for seed in 1..=4u64 {
            let s = world(size, 1, seed);
            let (w, h) = (s.grid.w as i32, s.grid.h as i32);
            for (i, e) in s.enemies.iter().enumerate().filter(|(_, e)| e.kind == ENEMY_SLIME) {
                assert_eq!(usize::from(e.id), i, "ids follow placement order");
                let (x0, y0, x1, y1) = e.hitbox_cells();
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        assert_eq!(s.grid.mat[(y * w + x) as usize], EMPTY, "size {size} seed {seed} slime {i} body at {x},{y}");
                    }
                }
                let under = s.grid.mat[((y1 + 1) * w + (e.x >> 4)) as usize];
                assert!(matches!(under, ROCK | DIRT | BEDROCK), "slime {i} floor material {under}");
                let cx = e.x >> 4;
                assert!(((cx - w / 2).abs() > ENEMY_SPAWN_CLEAR) || y1 >= 260 * (h - 64) / (1536 - 64) + ENEMY_SPAWN_ROWS, "slime {i} near the spawn column: {cx},{y1}");
                assert!(y1 < h);
                for p in &s.pickups {
                    assert!(!((i32::from(p.x) - cx).abs() < 8 && (i32::from(p.y) - y1).abs() < 8), "slime {i} on a pickup");
                }
                for o in s.enemies[..i].iter().filter(|o| o.kind == ENEMY_SLIME) {
                    assert!(((o.x - e.x).abs() >> 4) >= 20 || ((o.y - e.y).abs() >> 4) >= 20, "slimes {} and {i} overlap", o.id);
                }
            }
        }
    }
}

#[test]
fn slime_counts_per_size() {
    // Probe: counts at seed 1..=3 are written to /tmp/f4-slime-counts.txt for the report.
    let mut lines = String::new();
    for size in 0..=2u8 {
        let want = match size {
            0 => 8,
            1 => 25 * 1024 * 768 / (2048 * 1536),
            _ => 25,
        }
        .max(8);
        for seed in 1..=3u64 {
            let n = world(size, 1, seed).enemies.iter().filter(|e| e.kind == ENEMY_SLIME).count();
            lines.push_str(&format!("size {size} seed {seed}: {n} (target {want})\n"));
            assert!(n <= want && n * 10 >= want * 5, "size {size} seed {seed}: {n} slimes, target {want}");
            assert!(n <= MAX_ENEMIES);
        }
    }
    let _ = std::fs::write("/tmp/f4-slime-counts.txt", lines);
}

#[test]
fn the_cached_base_carries_the_enemies() {
    let donor = world(1, 1, 9);
    let base = donor.base.as_ref().unwrap();
    assert_eq!(base.enemies, donor.enemies);
    let snap = snapshot::write(&donor);
    let a = snapshot::restore(&snap).unwrap();
    let b = snapshot::restore_with(&snap, Some(base)).unwrap();
    assert_eq!(a.enemies, b.enemies);
    // a base for an enemies-off world is not reused for an enemies-on one
    let off = world(1, 0, 9);
    assert!(Sim::new_with_base(9, RoomConfig { size: 1, ..RoomConfig::survival() }, off.base.as_ref()).unwrap().enemies.len() > 0);
}

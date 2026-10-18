//! M5 slice 1: damage, hazards, death, respawn and the dead-state rules.
use sim::entities::*;
use sim::input::{encode_cast, encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::spells::isqrt;
use sim::tuning::*;

const PX: i32 = POS_ONE;

fn push(s: &mut Sim, b: Vec<u8>) {
    assert_eq!(s.push_input(&b), 0);
}

/// A game sim with players `ids` standing in a sealed 40x40 empty box far below the surface.
fn boxed(ids: &[u32]) -> Sim {
    let mut s = Sim::new(5, 1).unwrap();
    for &id in ids {
        push(&mut s, encode_join(id));
    }
    s.step();
    let w = s.grid.w;
    for y in 800..840 {
        for x in 500..540 {
            let edge = y == 800 || y == 839 || x == 500 || x == 539;
            s.grid.set(y * w + x, if edge { BEDROCK } else { EMPTY }, 0);
        }
    }
    for (k, &id) in ids.iter().enumerate() {
        place(&mut s, id, 510 + 8 * k as i32);
    }
    s
}

fn place(s: &mut Sim, id: u32, cx: i32) {
    let life = s.players.iter().find(|p| p.id == id).unwrap().life;
    push(s, encode_pos(id, life, cx * PX + PX / 2, 838 * PX, 0));
    s.step();
}

fn pl(s: &Sim, id: u32) -> &Player {
    s.players.iter().find(|p| p.id == id).unwrap()
}

fn fill_hitbox(s: &mut Sim, id: u32, m: u8) {
    let (x0, y0, x1, y1) = pl(s, id).hitbox_cells();
    let w = s.grid.w;
    for y in y0..=y1 {
        for x in x0..=x1 {
            s.grid.set(y as usize * w + x as usize, m, 0);
        }
    }
}

#[test]
fn isqrt_exact_squares_and_neighbours() {
    for n in 0..5000u64 {
        let sq = n * n;
        assert_eq!(isqrt(sq), n as u32);
        if n > 0 {
            assert_eq!(isqrt(sq - 1), n as u32 - 1);
        }
        assert_eq!(isqrt(sq + 1), if n == 0 { 1 } else { n as u32 });
    }
    assert_eq!(isqrt(u64::MAX), u32::MAX);
    assert_eq!(isqrt(1 << 62), 1 << 31);
}

#[test]
fn lava_costs_one_hp_every_two_ticks() {
    let mut s = boxed(&[1]);
    // Lava would flow, so refill the hitbox each tick and count only damage.
    let h0 = pl(&s, 1).health;
    for _ in 0..20 {
        fill_hitbox(&mut s, 1, LAVA);
        s.step();
    }
    assert_eq!(h0 - pl(&s, 1).health, 10);
}

#[test]
fn fire_costs_one_hp_every_six_ticks_phased_by_id() {
    let mut s = boxed(&[1, 2]);
    place(&mut s, 2, 530);
    let h = (pl(&s, 1).health, pl(&s, 2).health);
    let mut hits = ([0u32; 2], [0u32; 2]);
    let _ = &mut hits;
    let mut seen = [vec![], vec![]];
    for _ in 0..24 {
        fill_hitbox(&mut s, 1, FIRE);
        fill_hitbox(&mut s, 2, FIRE);
        let before = (pl(&s, 1).health, pl(&s, 2).health);
        let t = s.tick;
        s.step();
        if pl(&s, 1).health < before.0 {
            seen[0].push(t);
        }
        if pl(&s, 2).health < before.1 {
            seen[1].push(t);
        }
    }
    assert_eq!(h.0 - pl(&s, 1).health, 4);
    assert_eq!(h.1 - pl(&s, 2).health, 4);
    assert!(seen[0].iter().all(|t| (t + 1) % 6 == 0), "{:?}", seen[0]);
    assert!(seen[1].iter().all(|t| (t + 2) % 6 == 0), "{:?}", seen[1]);
}

#[test]
fn gunpowder_explosion_damages_by_falloff_knocks_back_and_gives_no_credit() {
    let mut s = boxed(&[1]);
    let w = s.grid.w;
    // Player at x=510.5, chest y = 833.5 (cells). Prime a gunpowder cell 3 cells to the right of the chest.
    s.grid.set(833 * w + 514, GUNPOWDER, 1);
    let before = pl(&s, 1).health;
    s.events.clear();
    s.step();
    let ex: Vec<_> = s.events.iter().filter(|e| e.kind == EV_EXPLODE).collect();
    assert_eq!(ex.len(), 1);
    assert_eq!((ex[0].player, ex[0].a, ex[0].b, ex[0].c), (0, 514, 833, 4));
    // dx = 510.5 - 514.5 = -4 cells, dy = 833.5? chest = 838 - 5 = 833, minus centre 833.5 -> -0.5.
    let dmg = before - pl(&s, 1).health;
    assert!(dmg == 0, "outside radius 4 takes nothing, took {dmg}");
    let k: Vec<_> = s.events.iter().filter(|e| e.kind == EV_KNOCK).collect();
    assert_eq!(k.len(), 1);
    assert!(k[0].a < 0, "knocked away (left), got {}", k[0].a);
    assert_eq!(pl(&s, 1).last_hit_by, 0);
    // Closer: 2 cells away takes damage 60 * (4 - 2) / 4 = 30 (distance floors to a whole cell).
    let mut s = boxed(&[1]);
    let w = s.grid.w;
    s.grid.set(833 * w + 512, GUNPOWDER, 1);
    s.step();
    let d = {
        let (dx, dy) = (i64::from(510 * PX + PX / 2 - 512 * PX - PX / 2), i64::from(833 * PX - 833 * PX - PX / 2));
        (isqrt((dx * dx + dy * dy) as u64) >> POS_SHIFT) as i32
    };
    assert_eq!(100 - pl(&s, 1).health as i32, 60 * (4 - d) / 4);
    assert!(pl(&s, 1).health < 100);
    assert_eq!(pl(&s, 1).last_hit_by, 0);
}

#[test]
fn explode_at_credits_other_owner_not_self_and_centre_knocks_up() {
    let mut s = boxed(&[1, 2]);
    // Chest of player 1 is (510.5, 833).
    s.events.clear();
    s.explode_at(510, 833, 18, 2, 5);
    assert_eq!(pl(&s, 1).last_hit_by, 2);
    assert_eq!(pl(&s, 1).last_hit_tick, s.tick);
    assert_eq!(pl(&s, 2).last_hit_by, 0, "owner is not their own last hitter");
    assert!(pl(&s, 1).health < 100 && pl(&s, 2).health < 100);
    let ev: Vec<_> = s.events.iter().filter(|e| e.kind == EV_EXPLODE).collect();
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0].player, ev[0].c), (2, 18));
    // Exactly at the chest: knocked straight up.
    let mut s = boxed(&[1]);
    s.players[0].y = 838 * PX + PX / 2; // chest exactly at the centre of cell (510, 833)
    s.events.clear();
    let (cx, cy) = (pl(&s, 1).x - PX / 2, pl(&s, 1).y - CHEST * PX - PX / 2);
    assert_eq!((cx % PX, cy % PX), (0, 0));
    s.explode_at(cx / PX, cy / PX, 10, 0, CAUSE_GUNPOWDER);
    let k = s.events.iter().find(|e| e.kind == EV_KNOCK).unwrap();
    assert_eq!((k.a, k.b), (0, -KNOCK_EXPLOSION));
    assert_eq!(pl(&s, 1).health, 100 - EXPLOSION_DAMAGE_MAX as u8);
}

#[test]
fn death_credits_killer_inside_window_only() {
    for (gap, want) in [(KILL_CREDIT_TICKS, 2), (KILL_CREDIT_TICKS + 1, 0)] {
        let mut s = boxed(&[1, 2]);
        while s.tick % 2 == 1 {
            s.step();
        }
        // Lava damages on even ticks, so the death happens in the next step, at tick `s.tick`.
        let death_tick = s.tick;
        s.players[0].last_hit_by = 2;
        s.players[0].last_hit_tick = death_tick - gap;
        s.players[0].health = 1;
        s.events.clear();
        fill_hitbox(&mut s, 1, LAVA);
        s.step();
        let d = s.events.iter().find(|e| e.kind == EV_DEATH).unwrap();
        assert_eq!((d.player, d.a, d.b, d.c), (1, want, i32::from(CAUSE_LAVA), 0), "gap {gap}");
        assert_eq!(pl(&s, 1).dead_until, death_tick + DEATH_TICKS);
    }
}

#[test]
fn self_kill_credits_last_other_hitter_or_nobody() {
    // With a recent other hitter.
    let mut s = boxed(&[1, 2]);
    let k = s.players.iter().position(|p| p.id == 1).unwrap();
    s.players[k].last_hit_by = 2;
    s.players[k].last_hit_tick = s.tick;
    s.players[k].health = 5;
    s.events.clear();
    let (cx, cy) = (510, 833);
    s.explode_at(cx, cy, 18, 1, 5);
    let d = s.events.iter().find(|e| e.kind == EV_DEATH && e.player == 1).unwrap();
    assert_eq!((d.a, d.b), (2, 5));
    // With nobody.
    let mut s = boxed(&[1]);
    s.players[0].health = 5;
    s.events.clear();
    s.explode_at(510, 833, 18, 1, 5);
    let d = s.events.iter().find(|e| e.kind == EV_DEATH).unwrap();
    assert_eq!(d.a, 0);
    assert_eq!(pl(&s, 1).last_hit_by, 0);
}

#[test]
fn a_dead_player_is_inert_and_respawns_exactly_at_dead_until() {
    let mut s = boxed(&[1, 2]);
    let k = 0;
    s.players[k].health = 1;
    s.explode_at(510, 833, 10, 2, 5);
    assert_eq!(pl(&s, 1).health, 0);
    let (dead_until, pos, life) = (pl(&s, 1).dead_until, (pl(&s, 1).x, pl(&s, 1).y), pl(&s, 1).life);
    assert_eq!(dead_until, s.tick + DEATH_TICKS);
    // Further damage does nothing and emits no second death.
    s.events.clear();
    s.explode_at(510, 833, 10, 2, 5);
    assert_eq!(pl(&s, 1).health, 0);
    assert!(s.events.iter().all(|e| e.kind != EV_DEATH));
    // Pos is ignored.
    push(&mut s, encode_pos(1, life, 515 * PX, 838 * PX, 1));
    s.step();
    assert_eq!((pl(&s, 1).x, pl(&s, 1).y), pos);
    // A cast is refused as dead.
    push(&mut s, encode_cast(1, 0, 0, 1));
    s.events.clear();
    s.step();
    assert!(s.events.iter().any(|e| e.kind == EV_CAST_REJECTED && e.b == REJECT_DEAD));
    // A bolt passes through the corpse: owner 2 fires Push at it.
    push(&mut s, encode_cast(2, 0, 0, 2));
    s.step();
    assert!(s.projectiles.len() <= 1);
    for _ in 0..8 {
        s.step();
    }
    assert!(s.events.iter().all(|e| !(e.kind == EV_KNOCK && e.player == 1)));
    // Until dead_until: still dead; at dead_until: respawned with life + 1 and full health.
    while s.tick < dead_until {
        assert_eq!(pl(&s, 1).health, 0, "tick {}", s.tick);
        s.step();
    }
    assert_eq!(s.tick, dead_until);
    s.events.clear();
    s.step();
    assert_eq!(s.tick, dead_until + 1);
    let r = s.events.iter().find(|e| e.kind == EV_RESPAWN).expect("respawn");
    assert_eq!(r.player, 1);
    assert_eq!((pl(&s, 1).life, pl(&s, 1).health), (life + 1, HEALTH_MAX));
}

#[test]
fn a_dead_player_collects_no_pickup() {
    let mut s = Sim::new(5, 1).unwrap();
    push(&mut s, encode_join(1));
    s.step();
    let (px, py, spell) = {
        let k = &s.pickups[0];
        (i32::from(k.x), i32::from(k.y), k.spell)
    };
    s.players[0].health = 0;
    s.players[0].dead_until = 10_000;
    s.players[0].x = px * PX + PX / 2;
    s.players[0].y = (py + 1) * PX;
    let c0 = s.players[0].charges[spell as usize];
    s.step();
    s.step();
    assert_eq!(s.players[0].charges[spell as usize], c0);
    assert_eq!(s.pickups[0].respawn_at, 0);
}

#[test]
fn a_player_who_left_while_dead_still_respawns() {
    let mut s = boxed(&[1]);
    s.players[0].health = 1;
    s.explode_at(510, 833, 10, 0, CAUSE_GUNPOWDER);
    push(&mut s, sim::input::encode_leave(1));
    s.step();
    for _ in 0..DEATH_TICKS + 2 {
        s.step();
    }
    assert_eq!(s.players[0].health, HEALTH_MAX);
    assert!(!s.players[0].active);
}

fn scripted(s: &mut Sim, t: u32) {
    match t {
        1 => push(s, encode_join(1)),
        2 => push(s, encode_join(2)),
        4 => {
            for (id, x) in [(1u32, 1000), (2, 1006)] {
                push(s, encode_pos(id, 0, x * PX, 230 * PX, 0));
            }
        }
        _ => {}
    }
    if t == 20 {
        // An explosion-sized bomb of gunpowder next to both, then lava poured on player 1 later.
        let w = s.grid.w;
        for dx in 0..3 {
            s.grid.set(225 * w + 1003 + dx, GUNPOWDER, 1);
        }
        s.players[0].health = 3;
        s.players[0].last_hit_by = 2;
        s.players[0].last_hit_tick = s.tick;
    }
}

#[test]
fn death_and_respawn_are_deterministic_and_snapshot_restores_while_dead() {
    let mut a = Sim::new(8, 1).unwrap();
    let mut b = Sim::new(8, 1).unwrap();
    let mut snap_at = None;
    for t in 1..=400u32 {
        scripted(&mut a, t);
        scripted(&mut b, t);
        a.step();
        b.step();
        assert_eq!(a.state_hash(), b.state_hash(), "tick {t}");
        if snap_at.is_none() && a.players.iter().any(|p| p.health == 0) {
            snap_at = Some((t, snapshot::write(&a)));
        }
    }
    let (t0, snap) = snap_at.expect("a player must die in the script");
    assert!(a.players[0].life >= 1, "and respawn");
    let mut r = snapshot::restore(&snap).unwrap();
    let mut c = Sim::new(8, 1).unwrap();
    for t in 1..=t0 {
        scripted(&mut c, t);
        c.step();
    }
    assert_eq!(r.state_hash(), c.state_hash());
    for t in t0 + 1..=400 {
        scripted(&mut r, t);
        r.step();
    }
    assert_eq!(r.state_hash(), a.state_hash());
}

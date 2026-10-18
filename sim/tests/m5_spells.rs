#![allow(clippy::manual_is_multiple_of)]
//! M5 slice 2: Fire bolt and Bomb. Expected values are literals, events are collected across every step.
use sim::entities::*;
use sim::input::{encode_cast, encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;
const RIGHT: u16 = 0;
const DOWN: u16 = 16384;
const LEFT: u16 = 32768;
const UP: u16 = 49152;

fn push(s: &mut Sim, b: Vec<u8>) {
    assert_eq!(s.push_input(&b), 0);
}

fn carved(s: &mut Sim) {
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
}

/// Rock everywhere in x 800..1300, y 100..700 except an air arena x 900..1150, y 100..200 (floor at 192),
/// then `n` players: player i stands at x = 1000 + 40 * i, feet on y = 190, with plenty of charges.
fn arena(n: u32) -> Sim {
    let mut s = Sim::new(11, 1).unwrap();
    let w = s.grid.w;
    for y in 100..700 {
        for x in 800..1300 {
            let air = (900..1150).contains(&x) && y < 192;
            s.grid.mat[y * w + x] = if air { EMPTY } else { ROCK };
            s.grid.aux[y * w + x] = 0;
        }
    }
    carved(&mut s);
    for id in 1..=n {
        push(&mut s, encode_join(id));
    }
    s.step();
    for id in 1..=n {
        place(&mut s, id, 1000 + 40 * (id as i32 - 1), 190);
        let k = s.players.iter().position(|p| p.id == id).unwrap();
        s.players[k].charges[4] = 20;
        s.players[k].charges[5] = 20;
    }
    s
}

fn place(s: &mut Sim, id: u32, x: i32, y: i32) {
    let life = s.players.iter().find(|p| p.id == id).unwrap().life;
    push(s, encode_pos(id, life, x * PX, y * PX, 0));
    s.step();
}

fn pl(s: &Sim, id: u32) -> &Player {
    s.players.iter().find(|p| p.id == id).unwrap()
}

/// Step up to `max` times, collecting every event of every step, until `f` accepts the events of a step.
fn collect_until(s: &mut Sim, max: u32, f: impl Fn(&[Event]) -> bool) -> Vec<Event> {
    let mut all = Vec::new();
    for _ in 0..max {
        s.step();
        all.extend(s.events.iter().copied());
        if f(&s.events) {
            return all;
        }
    }
    panic!("condition not reached in {max} ticks");
}

fn of(ev: &[Event], kind: u8) -> Vec<Event> {
    ev.iter().filter(|e| e.kind == kind).copied().collect()
}

/// Carve a big air room x 900..1100, y 20..600 for fuse tests.
fn open_air(s: &mut Sim) {
    let w = s.grid.w;
    for y in 20..600 {
        for x in 900..1100 {
            s.grid.mat[y * w + x] = EMPTY;
            s.grid.aux[y * w + x] = 0;
        }
    }
    carved(s);
}

// ---------------------------------------------------------------- Fire bolt

#[test]
fn fire_bolt_ignites_empty_cells_around_the_impact_and_spares_solids_and_liquids() {
    let mut s = arena(1);
    // Player 1 fires down at x=1000 and the bolt stops above the floor at (1000, 191). A rock cell and a
    // water cell sit inside the radius-3 disc; neither may be replaced.
    let w = s.grid.w;
    s.grid.set(190 * w + 1002, ROCK, 0);
    s.grid.set(189 * w + 998, WATER, 0);
    // A water cell walled in by rock, so it cannot flow away before the check.
    for (x, y) in [(998usize, 188usize), (997, 189), (999, 189), (998, 190), (997, 190), (999, 190)] {
        s.grid.set(y * w + x, ROCK, 0);
    }
    push(&mut s, encode_cast(1, 4, DOWN, 1));
    let ev = collect_until(&mut s, 30, |e| e.iter().any(|x| x.kind == EV_IMPACT));
    let imp = of(&ev, EV_IMPACT)[0];
    assert_eq!((imp.player, imp.a, imp.b, imp.c), (1, 1000, 191, 4));
    assert_eq!(s.grid.mat[190 * w + 1002], ROCK);
    assert_eq!(s.grid.mat[189 * w + 998], WATER);
    for (x, y) in [(1000usize, 192usize), (1000, 194), (1003, 192), (997, 193)] {
        assert_eq!(s.grid.mat[y * w + x], ROCK, "floor cell ({x},{y})");
    }
    // Fire at the impact cell and at both ends of the disc on the impact row.
    let fire: Vec<(usize, usize)> = (188..=191)
        .flat_map(|y| (996..=1004).map(move |x| (x, y)))
        .filter(|&(x, y)| s.grid.mat[y * w + x] == FIRE)
        .collect();
    // The whole impact row (997..=1003) is lit; the fire cells of the rows above have risen a tick.
    for x in 997..=1003 {
        assert!(fire.contains(&(x, 191)), "row cell {x}: {fire:?}");
    }
    assert_eq!(fire.len(), 13, "{fire:?}");
    // Outside the disc: nothing lit.
    assert_eq!(s.grid.mat[191 * w + 1004], EMPTY);
    assert_eq!(s.grid.mat[191 * w + 996], EMPTY);
}

#[test]
fn fire_bolt_direct_hit_deals_exactly_twenty_and_credits_the_owner() {
    let mut s = arena(2);
    place(&mut s, 2, 1030, 190);
    s.players[1].health = 100;
    push(&mut s, encode_cast(1, 4, RIGHT, 1));
    let ev = collect_until(&mut s, 30, |e| e.iter().any(|x| x.kind == EV_IMPACT));
    let imp = of(&ev, EV_IMPACT)[0];
    assert_eq!(imp.c, 4);
    // The bolt stops in the first cell of the victim's hitbox (its left edge).
    assert_eq!(imp.a, 1027);
    assert_eq!(pl(&s, 2).health, 80); // the hazard scan does not fire this tick ((11 + 2) % 6 != 0)
    assert_eq!(pl(&s, 2).last_hit_by, 1);
    assert_eq!(pl(&s, 2).last_hit_tick, 11);
    assert_eq!(pl(&s, 1).last_hit_by, 0);
}

#[test]
fn fire_bolt_kill_is_credited_with_cause_four() {
    let mut s = arena(2);
    place(&mut s, 2, 1030, 190);
    s.players[1].health = 20;
    push(&mut s, encode_cast(1, 4, RIGHT, 1));
    let ev = collect_until(&mut s, 30, |e| e.iter().any(|x| x.kind == EV_DEATH));
    let d = of(&ev, EV_DEATH)[0];
    assert_eq!((d.player, d.a, d.b), (2, 1, 4));
}

#[test]
fn fire_bolt_self_hit_after_grace_damages_but_never_sets_last_hit_to_self() {
    let mut s = arena(1);
    let (x, y) = (pl(&s, 1).x, pl(&s, 1).y);
    let mk = |age: u16| Projectile { owner: 1, spell: 4, cast_seq: 1, x: x << 4, y: (y - CHEST * PX) << 4, vx: 0, vy: 0, age };
    // Inside the grace period the bolt passes its owner untouched.
    s.projectiles.push(mk(5));
    s.step();
    assert_eq!(pl(&s, 1).health, 100);
    assert_eq!(s.projectiles.len(), 1);
    s.projectiles.clear();
    // After it: a hit that damages and leaves last-hit alone.
    s.projectiles.push(mk(OWNER_GRACE + 1));
    let ev = collect_until(&mut s, 1, |_| true);
    assert_eq!(of(&ev, EV_IMPACT).len(), 1);
    assert!(pl(&s, 1).health <= 80 && pl(&s, 1).health >= 79, "health {}", pl(&s, 1).health);
    assert_eq!(pl(&s, 1).last_hit_by, 0);
    assert_eq!(pl(&s, 1).last_hit_tick, 0);
}

// ---------------------------------------------------------------- Bomb

#[test]
fn bomb_on_contact_carves_radius_eighteen_damages_by_falloff_and_credits_the_owner() {
    let mut s = arena(2);
    place(&mut s, 2, 1010, 190);
    push(&mut s, encode_cast(1, 5, DOWN, 1));
    let ev = collect_until(&mut s, 30, |e| e.iter().any(|x| x.kind == EV_EXPLODE));
    let ex = of(&ev, EV_EXPLODE);
    assert_eq!(ex.len(), 1);
    assert_eq!((ex[0].player, ex[0].a, ex[0].b, ex[0].c), (1, 1000, 191, 18));
    let w = s.grid.w;
    let at = |x: usize, y: usize| s.grid.mat[y * w + x];
    // Inside the disc (not the rim): carved to Empty. The ring just outside: untouched rock.
    assert_eq!(at(1000, 207), EMPTY); // 16 below the centre
    assert_eq!(at(1015, 200), EMPTY);
    assert_eq!(at(1000, 210), ROCK); // 19 below
    assert_eq!(at(1019, 195), ROCK); // 19 right, 4 down
    // The rim cell straight below (distance exactly 18) is Empty or Fire, never rock.
    assert!(matches!(at(1000, 209), EMPTY | FIRE | SMOKE), "rim cell {}", at(1000, 209));
    let rock_left = (192..=209usize)
        .flat_map(|y| (982..=1018usize).map(move |x| (x, y)))
        .filter(|&(x, y)| {
            let (dx, dy) = (x as i32 - 1000, y as i32 - 191);
            dx * dx + dy * dy <= 17 * 17 && at(x, y) == ROCK
        })
        .count();
    assert_eq!(rock_left, 0);
    // Player 2: chest (1010.5, 185.5)-ish from the centre (1000.5, 191.5): about 11.6, so d = 11 cells:
    // 60 * (18 - 11) / 18 = 23. Fire from the rim may add 1 on the hazard schedule.
    let h = pl(&s, 2).health;
    assert!(h == 77 || h == 76, "health {h}");
    assert_eq!(pl(&s, 2).last_hit_by, 1);
    assert_eq!(pl(&s, 1).last_hit_by, 0);
    // Credit follows through a kill: set health low and bomb again.
    assert!(of(&ev, EV_KNOCK).iter().any(|k| k.player == 2 && k.c == 1));
}

#[test]
fn bomb_fuse_explodes_in_open_air_at_age_one_hundred_twenty_exactly() {
    let mut s = arena(1);
    open_air(&mut s);
    // Thrown upward at 3.1 cells a tick from (1000, 300): it rises about 62 cells, falls back and is
    // still in open air (floor at 600) when the fuse runs out.
    s.projectiles.push(Projectile { owner: 1, spell: 5, cast_seq: 1, x: 1000 << 8, y: 300 << 8, vx: 0, vy: -800, age: 0 });
    let start = s.tick;
    let mut first = None;
    for _ in 0..PROJ_MAX_AGE {
        s.step();
        if let Some(e) = s.events.iter().find(|e| e.kind == EV_EXPLODE) {
            first = Some((s.tick, e.a, e.b, e.c));
            break;
        }
        // Until then the bolt is alive and aged one per tick.
        let q = &s.projectiles[0];
        assert!(q.age < 120);
    }
    // The first step after the push is age 1, so age 120 is the 120th step.
    let (tick, a, b, c) = first.expect("the fuse must fire before the age-out");
    assert_eq!(tick, start + 120);
    assert_eq!(c, 18);
    assert_eq!((a, b), (1000, 485));
    assert!(s.projectiles.is_empty());
}

#[test]
fn ten_bombs_due_together_give_eight_explosions_then_two_and_the_two_do_not_move() {
    let mut s = arena(1);
    open_air(&mut s);
    for i in 0..10i32 {
        s.projectiles.push(Projectile {
            owner: 1,
            spell: 5,
            cast_seq: i as u16,
            x: (910 + 20 * i) << 8,
            y: 300 << 8,
            vx: 100,
            vy: -50,
            age: BOMB_FUSE - 1,
        });
    }
    s.step();
    let first = of(&s.events, EV_EXPLODE);
    assert_eq!(first.iter().map(|e| e.a).collect::<Vec<_>>(), vec![910, 930, 950, 970, 990, 1010, 1030, 1050]);
    assert_eq!(s.projectiles.len(), 2);
    let waiting: Vec<_> = s.projectiles.iter().map(|q| (q.x, q.y, q.vx, q.vy)).collect();
    assert_eq!(waiting, vec![((1070 << 8), 300 << 8, 100, -50), ((1090 << 8), 300 << 8, 100, -50)]);
    s.step();
    let second = of(&s.events, EV_EXPLODE);
    assert_eq!(second.iter().map(|e| (e.a, e.b)).collect::<Vec<_>>(), vec![(1070, 300), (1090, 300)]);
    assert!(s.projectiles.is_empty());
}

#[test]
fn a_contact_bomb_over_the_cap_waits_without_moving_and_fires_next_tick() {
    let mut s = arena(1);
    open_air(&mut s);
    for i in 0..8i32 {
        s.projectiles.push(Projectile { owner: 1, spell: 5, cast_seq: i as u16, x: (910 + 20 * i) << 8, y: 300 << 8, vx: 0, vy: 0, age: BOMB_FUSE - 1 });
    }
    // The ninth is falling onto a rock cell at (1090, 305): it would hit this tick.
    let w = s.grid.w;
    s.grid.set(305 * w + 1090, ROCK, 0);
    s.projectiles.push(Projectile { owner: 1, spell: 5, cast_seq: 9, x: 1090 << 8, y: 304 << 8, vx: 0, vy: 1000, age: 10 });
    s.step();
    assert_eq!(of(&s.events, EV_EXPLODE).len(), 8);
    assert_eq!(s.projectiles.len(), 1);
    let q = &s.projectiles[0];
    assert_eq!((q.x, q.y, q.vy, q.age), (1090 << 8, 304 << 8, 1000, 11));
    s.step();
    let e = of(&s.events, EV_EXPLODE);
    assert_eq!(e.len(), 1);
    assert_eq!((e[0].a, e[0].b), (1090, 304));
}

// ---------------------------------------------------------------- determinism

fn scripted(s: &mut Sim, t: u32) {
    if t % 7 == 1 {
        push(s, encode_cast(1, 4, [RIGHT, DOWN, LEFT, UP][(t / 7 % 4) as usize], t as u16));
    }
    if t % 31 == 3 {
        push(s, encode_cast(2, 5, [LEFT - 3000, UP + 4000, DOWN][(t / 31 % 3) as usize], t as u16));
    }
    if t % 40 == 0 {
        push(s, encode_cast(1, 5, UP - 6000, t as u16));
    }
}

#[test]
fn bombs_and_fire_bolts_are_deterministic_and_restore_mid_flight_and_mid_fuse() {
    let mut a = arena(2);
    let mut b = arena(2);
    open_air(&mut a);
    open_air(&mut b);
    let mut snap = None;
    for t in 1..=400u32 {
        scripted(&mut a, t);
        scripted(&mut b, t);
        a.step();
        b.step();
        assert_eq!(a.state_hash(), b.state_hash(), "tick {t}");
        // Mid-fuse: a bomb at least 60 ticks old and another still young.
        if snap.is_none() && a.projectiles.iter().any(|q| q.spell == 5 && q.age > 60) && a.projectiles.iter().any(|q| q.spell == 4) {
            snap = Some((t, snapshot::write(&a)));
        }
    }
    let (t0, bytes) = snap.expect("a bomb must be mid-fuse alongside a bolt");
    let mut explosions = 0;
    let mut r = snapshot::restore(&bytes).unwrap();
    let mut c = arena(2);
    open_air(&mut c);
    for t in 1..=t0 {
        scripted(&mut c, t);
        c.step();
    }
    assert_eq!(r.state_hash(), c.state_hash());
    for t in t0 + 1..=400 {
        scripted(&mut r, t);
        r.step();
        explosions += of(&r.events, EV_EXPLODE).len();
    }
    assert_eq!(r.state_hash(), a.state_hash());
    assert!(explosions >= 2, "the restored run must go through explosions, saw {explosions}");
}

#[test]
fn the_sandbox_has_no_spells() {
    let mut s = Sim::new(3, 0).unwrap();
    push(&mut s, encode_join(1));
    push(&mut s, encode_cast(1, 4, RIGHT, 1));
    push(&mut s, encode_cast(1, 5, RIGHT, 2));
    s.step();
    assert!(s.players.is_empty());
    assert!(s.projectiles.is_empty());
    assert!(s.events.is_empty());
}

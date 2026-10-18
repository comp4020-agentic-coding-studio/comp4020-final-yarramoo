//! M5 slice 3: dropped bags. Entity bytes, drop, merge, cap, expiry, fall, pickup, view, snapshots.
use sim::entities::*;
use sim::tuning::*;

fn bag(x: u16, y: u16, c: [u16; 4], e: u32) -> Bag {
    Bag { x, y, charges: c, expires_at: e }
}

/// Entity bytes for a game world with `bags`, plus the offset where the bag count starts.
fn bytes_with(bags: &[Bag]) -> (Vec<u8>, Vec<Pickup>, usize) {
    let s = sim::sim::Sim::new(5, 1).unwrap();
    let mut pk = s.pickups.clone();
    for p in pk.iter_mut() {
        p.respawn_at = 7;
    }
    let b = encode(&[Player::new(3, 100, 200)], &pk, &[], bags);
    let at = b.len() - 4 - bags.len() * BAG_BYTES;
    (b, s.pickups, at)
}

#[test]
fn bag_is_sixteen_bytes_and_round_trips() {
    assert_eq!(BAG_BYTES, 16);
    let bags = vec![bag(10, 20, [15, 0, 0, 5], 5400), bag(2047, 1535, [0, 1, 0, 0], u32::MAX)];
    let (b, mut pk, at) = bytes_with(&bags);
    assert_eq!(&b[at..at + 4], &2u32.to_le_bytes());
    // literal layout of the first bag: x, y, four charges, expires_at, all LE
    assert_eq!(&b[at + 4..at + 20], &[10, 0, 20, 0, 15, 0, 0, 0, 0, 0, 5, 0, 0x18, 0x15, 0, 0]);
    let (players, projs, got) = decode(&b, &mut pk, 2048, 1536).unwrap();
    assert_eq!((players.len(), projs.len()), (1, 0));
    assert_eq!(got, bags);
    // and with no bags
    let (b0, mut pk0, _) = bytes_with(&[]);
    assert!(decode(&b0, &mut pk0, 2048, 1536).unwrap().2.is_empty());
}

#[test]
fn hostile_bag_bytes_fail_cleanly() {
    let good = vec![bag(10, 20, [15, 0, 0, 5], 5400)];
    let (b, pk, at) = bytes_with(&good);
    let try_decode = |b: &[u8]| decode(b, &mut pk.clone(), 2048, 1536);
    assert!(try_decode(&b).is_ok());
    // count above the cap, with a length that would match it
    let mut c = b.clone();
    c[at..at + 4].copy_from_slice(&(MAX_BAGS as u32 + 1).to_le_bytes());
    assert!(try_decode(&c).is_err());
    // huge count
    c[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(try_decode(&c).is_err());
    // count says 2, bytes hold 1
    c[at..at + 4].copy_from_slice(&2u32.to_le_bytes());
    assert!(try_decode(&c).is_err());
    // truncated, trailing byte, and cut off before the bag count
    assert!(try_decode(&b[..b.len() - 1]).is_err());
    let mut t = b.clone();
    t.push(0);
    assert!(try_decode(&t).is_err());
    assert!(try_decode(&b[..at + 2]).is_err());
    // out-of-world coordinates
    for (x, y) in [(2048u16, 5u16), (5, 1536), (u16::MAX, u16::MAX)] {
        let (b, pk, _) = bytes_with(&[bag(x, y, [1, 0, 0, 0], 0)]);
        assert!(decode(&b, &mut pk.clone(), 2048, 1536).is_err(), "{x},{y}");
    }
    // all-zero charges
    let (b, pk, _) = bytes_with(&[bag(5, 5, [0; 4], 0)]);
    assert!(decode(&b, &mut pk.clone(), 2048, 1536).is_err());
    // a full 64 bags is accepted
    let many: Vec<Bag> = (0..MAX_BAGS as u16).map(|i| bag(i, 5, [1, 0, 0, 0], 9)).collect();
    let (b, pk, _) = bytes_with(&many);
    assert_eq!(decode(&b, &mut pk.clone(), 2048, 1536).unwrap().2.len(), MAX_BAGS);
}

// ---- drop, merge, cap, expiry, fall, pickup, view (slice 3 commit 2) ---------------------------------------

use sim::input::{encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;

const PX: i32 = POS_ONE;
const INF: u16 = INFINITE;

fn push(s: &mut Sim, b: Vec<u8>) {
    assert_eq!(s.push_input(&b), 0);
}

/// Game sim with players `ids` in a sealed 40x40 empty box (cells 500..540 x 800..840, bedrock rim),
/// standing on the bedrock floor (feet line 839) at x = 510, 518, ... (8 cells apart).
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
        stand(&mut s, id, 510 + 8 * k as i32);
    }
    s
}

/// Put a player's feet on the box floor at column `cx`, through the real Pos input.
fn stand(s: &mut Sim, id: u32, cx: i32) {
    let life = pl(s, id).life;
    push(s, encode_pos(id, life, cx * PX + PX / 2, 839 * PX, 0));
    s.step();
}

fn pl(s: &Sim, id: u32) -> &Player {
    s.players.iter().find(|p| p.id == id).unwrap()
}

fn set_charges(s: &mut Sim, id: u32, c: [u16; 6]) {
    s.players.iter_mut().find(|p| p.id == id).unwrap().charges = c;
}

/// Kill player `id` with a small explosion on its chest (others are 8+ cells away, outside 1.5 r = 6).
/// Returns the events of that call (nothing steps).
fn kill(s: &mut Sim, id: u32) -> Vec<Event> {
    s.players.iter_mut().find(|p| p.id == id).unwrap().health = 1;
    let p = pl(s, id);
    let (cx, cy) = (p.x >> POS_SHIFT, (p.y >> POS_SHIFT) - CHEST);
    s.events.clear();
    s.explode_at(cx, cy, 4, 0, CAUSE_GUNPOWDER);
    assert_eq!(pl(s, id).health, 0);
    s.events.clone()
}

fn death_of(evs: &[Event], id: u32) -> Event {
    *evs.iter().find(|e| e.kind == EV_DEATH && e.player == id).expect("EV_DEATH")
}

#[test]
fn death_drops_exactly_the_finite_charges_and_keeps_push_and_blast() {
    let mut s = boxed(&[1]);
    set_charges(&mut s, 1, [INF, INF, 15, 0, 0, 5]);
    let t = s.tick;
    let d = death_of(&kill(&mut s, 1), 1);
    assert_eq!((d.a, d.b, d.c), (0, i32::from(CAUSE_GUNPOWDER), 1));
    // feet cell: x 510, y (839) - 1 = 838
    assert_eq!(s.bags, vec![Bag { x: 510, y: 838, charges: [15, 0, 0, 5], expires_at: t + 5400 }]);
    assert_eq!(pl(&s, 1).charges, [INF, INF, 0, 0, 0, 0]);
}

#[test]
fn death_with_no_finite_charges_drops_nothing() {
    let mut s = boxed(&[1]);
    let d = death_of(&kill(&mut s, 1), 1);
    assert_eq!(d.c, 0);
    assert!(s.bags.is_empty());
    assert_eq!(pl(&s, 1).charges, START_CHARGES);
}

#[test]
fn a_victim_holding_an_infinite_finite_slot_keeps_it() {
    let mut s = boxed(&[1]);
    set_charges(&mut s, 1, [INF, INF, INF, 7, 0, 0]);
    kill(&mut s, 1);
    assert_eq!(s.bags[0].charges, [0, 7, 0, 0]);
    assert_eq!(pl(&s, 1).charges, [INF, INF, INF, 0, 0, 0]);
}

#[test]
fn drops_merge_within_eight_cells_chebyshev_and_not_at_nine() {
    for (cx, merges) in [(518, true), (519, false)] {
        let mut s = boxed(&[1, 2]);
        set_charges(&mut s, 1, [INF, INF, 15, 0, 0, 0]);
        set_charges(&mut s, 2, [INF, INF, 1, 2, 0, 0]);
        s.bags.clear();
        kill(&mut s, 1);
        stand(&mut s, 2, cx);
        s.bags[0].expires_at = 123; // so a merge visibly resets it
        let t = s.tick;
        let d = death_of(&kill(&mut s, 2), 2);
        assert_eq!(d.c, 1);
        if merges {
            assert_eq!(s.bags, vec![Bag { x: 510, y: 838, charges: [16, 2, 0, 0], expires_at: t + 5400 }], "at {cx}");
        } else {
            assert_eq!(s.bags.len(), 2, "at {cx}");
            assert_eq!(s.bags[0].expires_at, 123);
            assert_eq!((s.bags[1].x, s.bags[1].charges), (cx as u16, [1, 2, 0, 0]));
        }
    }
}

#[test]
fn merge_picks_the_first_bag_in_order_and_saturates_below_infinite() {
    let mut s = boxed(&[1]);
    set_charges(&mut s, 1, [INF, INF, 1000, 0, 0, 0]);
    // Two bags both within 8 of the drop cell (510, 838); the first in vector order wins.
    s.bags = vec![bag(515, 838, [65000, 0, 0, 0], 99), bag(505, 838, [1, 0, 0, 0], 99)];
    kill(&mut s, 1);
    assert_eq!(s.bags[0].charges, [INF - 1, 0, 0, 0]);
    assert_eq!(s.bags[1].charges, [1, 0, 0, 0]);
    assert_eq!(s.bags.len(), 2);
}

#[test]
fn the_sixty_fifth_bag_evicts_the_oldest_and_its_charges_are_gone() {
    let mut s = boxed(&[1]);
    set_charges(&mut s, 1, [INF, INF, 0, 0, 0, 9]);
    s.bags = (0..MAX_BAGS as u16).map(|i| bag(20 + 20 * i, 100, [i + 1, 0, 0, 0], 99_999)).collect();
    kill(&mut s, 1);
    assert_eq!(s.bags.len(), MAX_BAGS);
    assert_eq!(s.bags[0].charges, [2, 0, 0, 0], "bag 0 (charges 1) was evicted, order kept");
    assert_eq!(s.bags[MAX_BAGS - 1].charges, [0, 0, 0, 9]);
    assert!(s.bags.iter().all(|b| b.charges[0] != 1));
}

#[test]
fn a_bag_lasts_exactly_bag_lifetime_ticks() {
    let mut s = boxed(&[1, 2]);
    set_charges(&mut s, 1, [INF, INF, 3, 0, 0, 0]);
    let t0 = s.tick;
    kill(&mut s, 1);
    let expires = s.bags[0].expires_at;
    assert_eq!(expires, t0 + BAG_LIFETIME);
    // Player 1 respawns far away at t0 + 180 and player 2 is 8 cells off, so nobody takes it.
    while s.tick < expires {
        assert_eq!(s.bags.len(), 1, "gone early at tick {}", s.tick);
        s.step();
    }
    // The step that runs with tick == expires removes it.
    assert_eq!(s.tick, expires);
    assert_eq!(s.bags.len(), 1);
    s.step();
    assert!(s.bags.is_empty());
}

#[test]
fn a_bag_falls_through_empty_and_gas_and_stops_on_anything_else() {
    // Row 812 is set just before each step, which is what the bag reads (update_entities runs first).
    for (m, falls) in [(EMPTY, true), (SMOKE, true), (STEAM, true), (FIRE, true), (WATER, false), (SAND, false), (ROCK, false), (LAVA, false), (BEDROCK, false)] {
        let mut s = boxed(&[1]);
        s.bags = vec![bag(520, 811, [1, 0, 0, 0], 99_999)];
        s.grid.set(812 * s.grid.w + 520, m, 0);
        s.step();
        assert_eq!(s.bags[0].y, if falls { 812 } else { 811 }, "material {m}");
    }
    // Falls to the floor and stops there; never leaves the world.
    let mut s = boxed(&[1]);
    s.bags = vec![bag(520, 801, [1, 0, 0, 0], 99_999)];
    for _ in 0..60 {
        s.step();
    }
    assert_eq!(s.bags[0].y, 838);
}

#[test]
fn a_bag_at_the_world_floor_does_not_fall_out() {
    let mut s = boxed(&[1]);
    let h = s.grid.h as u16;
    s.bags = vec![bag(520, h - 1, [1, 0, 0, 0], 99_999)];
    s.step();
    assert_eq!(s.bags[0].y, h - 1);
}

#[test]
fn the_respawned_victim_takes_their_own_bag_back() {
    let mut s = boxed(&[1]);
    set_charges(&mut s, 1, [INF, INF, 15, 0, 0, 5]);
    kill(&mut s, 1);
    let mut evs = vec![];
    while pl(&s, 1).health == 0 {
        s.step();
        evs.extend(s.events.clone());
    }
    assert_eq!(pl(&s, 1).charges, [INF, INF, 0, 0, 0, 0], "respawn does not refill");
    assert!(evs.iter().all(|e| e.kind != EV_BAG_PICKUP), "no one took it while the victim was dead");
    assert_eq!(s.bags.len(), 1);
    stand(&mut s, 1, 510);
    let taken: Vec<_> = s.events.iter().filter(|e| e.kind == EV_BAG_PICKUP).collect();
    assert_eq!(taken.len(), 1);
    assert_eq!((taken[0].player, taken[0].a, taken[0].b, taken[0].c), (1, 510, 838, 20));
    assert_eq!(pl(&s, 1).charges, [INF, INF, 15, 0, 0, 5]);
    assert!(s.bags.is_empty());
}

#[test]
fn a_dead_player_cannot_take_a_bag() {
    let mut s = boxed(&[1]);
    s.bags = vec![bag(510, 838, [4, 0, 0, 0], 99_999)];
    s.players[0].health = 0;
    s.players[0].dead_until = 50_000;
    for _ in 0..5 {
        s.step();
        assert!(s.events.iter().all(|e| e.kind != EV_BAG_PICKUP));
    }
    assert_eq!(s.bags.len(), 1);
    assert_eq!(pl(&s, 1).charges, START_CHARGES);
}

#[test]
fn two_players_on_one_bag_the_lower_id_gets_it() {
    let mut s = boxed(&[1, 2]);
    s.players[0].x = 510 * PX + 8;
    s.players[1].x = 512 * PX + 8;
    s.bags = vec![bag(511, 838, [4, 0, 0, 1], 99_999)];
    s.step();
    let taken: Vec<_> = s.events.iter().filter(|e| e.kind == EV_BAG_PICKUP).collect();
    assert_eq!(taken.len(), 1);
    assert_eq!((taken[0].player, taken[0].c), (1, 5));
    assert_eq!(pl(&s, 1).charges, [INF, INF, 4, 0, 0, 1]);
    assert_eq!(pl(&s, 2).charges, START_CHARGES);
}

#[test]
fn pickup_leaves_infinite_slots_and_saturates() {
    let mut s = boxed(&[1]);
    set_charges(&mut s, 1, [INF, INF, INF, 65_530, 0, 0]);
    s.bags = vec![bag(510, 838, [5, 100, 0, 2], 99_999)];
    s.step();
    assert_eq!(pl(&s, 1).charges, [INF, INF, INF, INF - 1, 0, 2]);
    let e = s.events.iter().find(|e| e.kind == EV_BAG_PICKUP).unwrap();
    assert_eq!(e.c, 107, "the whole bag is taken");
}

#[test]
fn the_bag_view_record() {
    let mut s = Sim::new(5, 1).unwrap();
    s.bags = vec![bag(10, 20, [1, 2, 3, 4], 9), bag(7, 8, [u16::MAX - 1, u16::MAX - 1, 0, 0], 9)];
    let mut out = vec![0u8; 2000 * ENTITY_BYTES];
    let n = write_view(&s.players, &s.pickups, &s.projectiles, &s.bags, 0, &mut out, 2000);
    assert_eq!(n, s.pickups.len() + 2);
    let r = &out[(n - 2) * ENTITY_BYTES..(n - 1) * ENTITY_BYTES];
    assert_eq!(r[0], ENT_BAG);
    assert_eq!(&r[1..5], &0u32.to_le_bytes());
    assert_eq!((r[5], r[6]), (1, 0));
    assert_eq!(&r[7..11], &(10 * 16 + 8i32).to_le_bytes());
    assert_eq!(&r[11..15], &(20 * 16 + 8i32).to_le_bytes());
    assert_eq!(&r[15..17], &10u16.to_le_bytes());
    assert_eq!(r[17], 0);
    let r = &out[(n - 1) * ENTITY_BYTES..n * ENTITY_BYTES];
    assert_eq!(&r[1..5], &1u32.to_le_bytes());
    assert_eq!(&r[15..17], &u16::MAX.to_le_bytes(), "total capped to u16");
    // TypeScript's MAX_ENTITIES (shared/sim.ts) is 1600: every kind at its cap must fit.
    assert!(MAX_PLAYERS + s.pickups.len() + MAX_PROJECTILES + MAX_BAGS <= 1600);
}

// ---- snapshots and sleeping ------------------------------------------------------------------------------

/// A scripted run in the box: deaths, a merge, a respawn, and a pickup by the respawned victim.
fn scripted(s: &mut Sim, t: u32) {
    match t {
        5 => {
            set_charges(s, 1, [INF, INF, 15, 3, 0, 5]);
            kill(s, 1);
        }
        40 => {
            set_charges(s, 2, [INF, INF, 2, 0, 9, 0]);
            stand(s, 2, 540 - 1 - 8); // 8 cells from the first bag, not merging at 9 is covered elsewhere
            set_charges(s, 2, [INF, INF, 2, 0, 9, 0]);
            kill(s, 2);
        }
        _ => {}
    }
    if t == 300 {
        let life = pl(s, 1).life;
        push(s, encode_pos(1, life, 510 * PX + PX / 2, 839 * PX, 0));
    }
}

#[test]
fn d5_snapshots_with_bags_and_a_dead_player_continue_identically() {
    let end = 420u32;
    let mut a = boxed(&[1, 2]);
    let mut want = vec![];
    let mut snaps = vec![];
    let cuts = [4u32, 6, 41, 100, 200, 299, 301, 400];
    let base = a.tick;
    for t in 1..=end {
        scripted(&mut a, t);
        a.step();
        want.push((t, a.state_hash()));
        if cuts.contains(&t) {
            snaps.push((t, snapshot::write(&a), a.bags.clone(), a.players.iter().any(|p| p.health == 0)));
        }
    }
    let _ = base;
    assert!(snaps.iter().any(|s| !s.2.is_empty() && s.3), "some cut has a bag and a dead player");
    for (cut, snap, bags, _) in snaps {
                let mut r = snapshot::restore(&snap).unwrap();
        assert_eq!(r.bags, bags, "cut {cut}");
        for t in cut + 1..=end {
            scripted(&mut r, t);
            r.step();
            assert_eq!(r.state_hash(), want[(t - 1) as usize].1, "cut {cut} tick {t}");
        }
    }
    // The script really exercised everything.
    assert_eq!(a.bags.len(), 1, "the second death's bag is still on the ground; the first was taken at 300");
}

/// Run with sleeping on or off: a bag falling in a far (inactive) chunk and one in the player's own region.
fn sleep_run(sleep: bool) -> (Vec<u64>, Sim) {
    let mut s = Sim::new(11, 1).unwrap();
    s.grid.sleep_enabled = sleep;
    push(&mut s, encode_join(1));
    s.step();
    let (px, py) = (pl(&s, 1).x >> POS_SHIFT, pl(&s, 1).y >> POS_SHIFT);
    s.bags = vec![bag(100, 50, [1, 2, 3, 4], 99_999), bag((px + 30) as u16, (py - 120) as u16, [5, 0, 0, 0], 99_999)];
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
fn sleeping_is_invisible_to_falling_bags() {
    let (on, s_on) = sleep_run(true);
    let (off, s_off) = sleep_run(false);
    assert_eq!(on, off);
    assert_eq!(s_on.bags, s_off.bags);
    assert!(s_on.bags[0].y > 50 + 30 && s_on.bags[1].y > pl(&s_on, 1).y as u16 / 16 - 120, "bags fell");
    assert!(s_on.grid.ran_chunks < s_off.grid.ran_chunks, "sleeping really skipped chunks in the sleeping run");
}

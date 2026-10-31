#![allow(clippy::manual_is_multiple_of)]
//! M4b: casting, projectiles, knockback, bursts, order across a snapshot, the respawn path.
use sim::entities::*;
use sim::input::{encode_cast, encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::spells::{ACID_FLASK, LAVA_FLASK, OIL_FLASK, WALL};
use sim::tuning::*;

const PX: i32 = POS_ONE;
/// Angle units: 65536 per turn, 0 along +x, growing towards +y (down).
const RIGHT: u16 = 0;
const DOWN: u16 = 16384;
const LEFT: u16 = 32768;

fn push(s: &mut Sim, b: Vec<u8>) {
    assert_eq!(s.push_input(&b), 0);
}

/// A game world with an empty arena (x 900..1150, y 100..200, floor of rock below) and `n` players standing
/// in it, player i at x = 1000 + 40 * i, feet on y = 190.
fn arena(n: u32) -> Sim {
    let mut s = Sim::new(11, 1).unwrap();
    let w = s.grid.w;
    for y in 100..200 {
        for x in 900..1150 {
            s.grid.mat[y * w + x] = if y >= 192 { ROCK } else { EMPTY };
        }
    }
    carved(&mut s);
    for id in 1..=n {
        push(&mut s, encode_join(id));
    }
    s.step();
    for id in 1..=n {
        place(&mut s, id, 1000 + 40 * (id as i32 - 1), 190);
    }
    s
}

/// Tests edit `grid.mat` directly; mark the chunks so hashing and snapshots see the change.
fn carved(s: &mut Sim) {
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
}

fn place(s: &mut Sim, id: u32, x: i32, y: i32) {
    let life = s.players.iter().find(|p| p.id == id).unwrap().life;
    push(s, encode_pos(id, life, x * PX, y * PX, 0));
    s.step();
}

fn count(s: &Sim, kind: u8) -> usize {
    s.events.iter().filter(|e| e.kind == kind).count()
}

fn run_until<F: FnMut(&Sim) -> bool>(s: &mut Sim, max: u32, mut f: F) {
    for _ in 0..max {
        if f(s) {
            return;
        }
        s.step();
    }
    assert!(f(s), "condition not reached in {max} ticks");
}

#[test]
fn cast_spawns_a_bolt_pays_a_charge_and_starts_the_cooldown() {
    let mut s = arena(1);
    push(&mut s, encode_cast(1, 2, RIGHT, 7)); // Water: no charges yet
    s.step();
    assert_eq!(s.events.iter().find(|e| e.kind == EV_CAST_REJECTED).map(|e| (e.b, e.c)), Some((REJECT_CHARGES, 7)));
    assert!(s.projectiles.is_empty());
    s.players[0].charges[2] = 2;
    push(&mut s, encode_cast(1, 2, RIGHT, 8));
    s.step();
    assert_eq!(count(&s, EV_CAST), 1);
    assert_eq!(s.projectiles.len(), 1);
    assert_eq!(s.projectiles[0].cast_seq, 8);
    assert_eq!(s.players[0].charges[2], 1);
    // The cooldown (10 ticks) refuses a second cast, then lets one through.
    push(&mut s, encode_cast(1, 2, RIGHT, 9));
    s.step();
    assert_eq!(s.events.iter().find(|e| e.kind == EV_CAST_REJECTED).map(|e| e.b), Some(REJECT_COOLDOWN));
    for _ in 0..COOLDOWN[2] {
        s.step();
    }
    push(&mut s, encode_cast(1, 2, RIGHT, 10));
    s.step();
    assert_eq!(count(&s, EV_CAST), 1);
    assert_eq!(s.players[0].charges[2], 0);
    // Infinite spells never run out.
    assert_eq!(s.players[0].charges[0], INFINITE);
    push(&mut s, encode_cast(1, 0, RIGHT, 11));
    s.step();
    assert_eq!(s.players[0].charges[0], INFINITE);
}

#[test]
fn unknown_unimplemented_and_inactive_casts_are_refused() {
    let mut s = arena(1);
    push(&mut s, encode_cast(1, NUM_SPELLS as u8, RIGHT, 1)); // one past the last spell
    push(&mut s, encode_cast(1, 200, RIGHT, 2));
    s.step();
    assert_eq!(count(&s, EV_CAST_REJECTED), 2);
    push(&mut s, encode_cast(99, 0, RIGHT, 3)); // no such player: nothing, not even an event
    s.step();
    assert!(s.events.is_empty());
    push(&mut s, sim::input::encode_leave(1));
    s.step();
    push(&mut s, encode_cast(1, 0, RIGHT, 4));
    s.step();
    assert!(s.projectiles.is_empty() && s.events.is_empty());
}

#[test]
fn the_sandbox_ignores_casts() {
    let mut s = Sim::new(1, 0).unwrap();
    push(&mut s, encode_cast(1, 0, RIGHT, 1));
    s.step();
    assert!(s.events.is_empty() && s.projectiles.is_empty());
}

#[test]
fn push_knocks_back_the_victim_sets_last_hit_and_does_no_damage() {
    let mut s = arena(2);
    // Player 1 at x 1000, player 2 at x 1040, same height: aim right.
    push(&mut s, encode_cast(1, 0, RIGHT, 1));
    s.step();
    let mut knock = None;
    run_until(&mut s, 60, |s| {
        knock = knock.or(s.events.iter().find(|e| e.kind == EV_KNOCK).copied());
        knock.is_some()
    });
    let k = knock.unwrap();
    assert_eq!((k.player, k.c), (2, 1));
    assert_eq!(k.a, KNOCK_PUSH);
    assert!(k.b.abs() <= 1);
    assert!(s.projectiles.is_empty());
    let v = &s.players[1];
    assert_eq!((v.last_hit_by, v.last_hit_tick), (1, s.tick - 1));
    assert_eq!(v.health, HEALTH_MAX);
    // The sim does not move players.
    assert_eq!(v.x, 1040 * PX);
    assert_eq!(s.players[0].last_hit_by, 0);
}

#[test]
fn a_bolt_passes_its_owner_for_the_grace_period_and_stops_on_terrain() {
    let mut s = arena(1);
    // Fired straight down: it leaves the owner's hitbox, hits the rock floor and reports where.
    push(&mut s, encode_cast(1, 0, DOWN, 1));
    s.step();
    let mut impact = None;
    run_until(&mut s, 60, |s| {
        impact = impact.or(s.events.iter().find(|e| e.kind == EV_IMPACT).copied());
        impact.is_some()
    });
    let e = impact.unwrap();
    assert_eq!((e.player, e.a, e.b), (1, 1000, 191)); // the last free cell above the floor at row 192
    assert!(s.projectiles.is_empty());
    assert_eq!(count(&s, EV_KNOCK), 0);
}

#[test]
fn blast_is_a_cone_in_front_within_the_radius() {
    let mut s = arena(3);
    // Player 2 at 1040 is 40 cells away: outside the 24-cell radius.
    place(&mut s, 2, 1000 + 20, 190); // in front, inside
    place(&mut s, 3, 1000 - 15, 190); // behind
    push(&mut s, encode_cast(1, 1, RIGHT, 1));
    s.step();
    let knocks: Vec<_> = s.events.iter().filter(|e| e.kind == EV_KNOCK).collect();
    assert_eq!(knocks.len(), 1);
    assert_eq!((knocks[0].player, knocks[0].a, knocks[0].c), (2, KNOCK_BLAST, 1));
    assert_eq!(s.players[1].last_hit_by, 1);
    assert_eq!(s.players[2].last_hit_by, 0);
    assert!(s.projectiles.is_empty(), "blast has no projectile");
    // Too far, and off to the side of the cone, are both missed.
    for _ in 0..COOLDOWN[1] {
        s.step();
    }
    place(&mut s, 2, 1000 + 30, 190);
    push(&mut s, encode_cast(1, 1, RIGHT, 2));
    s.step();
    assert_eq!(count(&s, EV_KNOCK), 0);
    for _ in 0..COOLDOWN[1] {
        s.step();
    }
    place(&mut s, 2, 1000 + 4, 190 - 40); // above, nearly out of radius: not in a rightward cone
    place(&mut s, 2, 1000 + 4, 180);
    push(&mut s, encode_cast(1, 1, RIGHT, 3));
    s.step();
    assert_eq!(count(&s, EV_KNOCK), 0);
}

#[test]
fn water_bolt_bursts_into_about_sixty_water_cells_in_empty_cells_only() {
    let mut s = arena(1);
    s.players[0].charges[2] = 5;
    let before = s.grid.mat.iter().filter(|&&m| m == WATER).count();
    push(&mut s, encode_cast(1, 2, DOWN, 1));
    s.step();
    run_until(&mut s, 80, |s| s.projectiles.is_empty());
    let after = s.grid.mat.iter().filter(|&&m| m == WATER).count();
    // Water cells settle but none are created or destroyed by falling.
    assert_eq!(after - before, WATER_BURST_CELLS);
    // The floor is untouched.
    assert!((1000 - 10..1000 + 10).all(|x| s.grid.mat[192 * s.grid.w + x] == ROCK));
    // Into solid rock nothing is placed: aim at a wall with no free cell around the impact point.
    let mut t = arena(1);
    t.players[0].charges[2] = 1;
    let w = t.grid.w;
    for y in 150..190 {
        for x in 1004..1040 {
            t.grid.mat[y * w + x] = ROCK;
        }
    }
    carved(&mut t);
    let rock = t.grid.mat.iter().filter(|&&m| m == ROCK).count();
    push(&mut t, encode_cast(1, 2, RIGHT, 1));
    t.step();
    run_until(&mut t, 80, |s| s.projectiles.is_empty());
    assert!(t.grid.mat.iter().filter(|&&m| m == ROCK).count() == rock, "rock is never overwritten");
}

#[test]
fn rose_seed_scatters_at_most_eight_seeds() {
    let mut s = arena(1);
    s.players[0].charges[3] = 5;
    push(&mut s, encode_cast(1, 3, DOWN, 1));
    s.step();
    run_until(&mut s, 80, |s| s.projectiles.is_empty());
    let seeds = s.grid.mat.iter().filter(|&&m| m == SEED).count();
    assert!((1..=SEED_BURST_CELLS as usize).contains(&seeds), "{seeds} seeds");
}

#[test]
fn projectile_counts_are_capped_per_player_and_in_total() {
    let mut s = arena(1);
    // Push has a 20-tick cooldown, so use pre-seeded bolts to fill the per-player cap.
    for k in 0..MAX_PROJECTILES_PER_PLAYER {
        s.projectiles.push(Projectile { owner: 1, spell: 0, cast_seq: k as u16, x: 1000 << 8, y: 150 << 8, vx: 0, vy: 0, age: 0 });
    }
    push(&mut s, encode_cast(1, 0, LEFT, 99));
    s.step();
    assert_eq!(s.events.iter().find(|e| e.kind == EV_CAST_REJECTED).map(|e| e.b), Some(REJECT_FULL));
    assert_eq!(s.projectiles.len(), MAX_PROJECTILES_PER_PLAYER);
    assert_eq!(s.players[0].cooldown_until[0], 0, "a refused cast costs nothing");
}

#[test]
fn bolts_leave_the_world_and_expire() {
    let mut s = arena(1);
    // A bolt that never meets anything is removed by age.
    s.projectiles.push(Projectile { owner: 1, spell: 0, cast_seq: 0, x: 1000 << 8, y: 120 << 8, vx: 0, vy: 0, age: 0 });
    for _ in 0..=PROJ_MAX_AGE {
        s.step();
    }
    assert!(s.projectiles.is_empty());
}

#[test]
fn projectiles_keep_spawn_order_through_removals() {
    let mut s = arena(1);
    let mk = |seq: u16, x: i32| Projectile { owner: 1, spell: 0, cast_seq: seq, x: x << 8, y: 120 << 8, vx: 0, vy: 0, age: 0 };
    s.projectiles = vec![mk(1, 920), mk(2, 940), mk(3, 960), mk(4, 980)];
    s.projectiles[1].age = PROJ_MAX_AGE; // dies next tick
    s.step();
    assert_eq!(s.projectiles.iter().map(|q| q.cast_seq).collect::<Vec<_>>(), vec![1, 3, 4]);
}

/// D5 with bolts in flight: a snapshot cut at any tick of a firefight restores to the same hash, and the
/// restored run continues identically (spawn order, ages and velocities all survive).
#[test]
fn d5_snapshot_with_projectiles_in_flight() {
    let script = |s: &Sim, t: u32| -> Vec<Vec<u8>> {
        let _ = s;
        let mut v = vec![];
        match t {
            2 | 3 => v.push(encode_join(t - 1)),
            _ => {}
        }
        if t >= 6 && t % 7 == 0 {
            v.push(encode_cast(1, (t / 7 % 4) as u8, [RIGHT, DOWN, 3000, 60000][(t / 7 % 4) as usize], t as u16));
        }
        if t >= 6 && t % 9 == 0 {
            v.push(encode_cast(2, (t / 9 % 4) as u8, [LEFT, 40000, 1000, DOWN][(t / 9 % 4) as usize], t as u16));
        }
        v
    };
    let build = || {
        let mut s = arena(0);
        for id in 1..=2u32 {
            s.players.push(Player::new(id, (1000 + 30 * (id as i32 - 1)) * PX, 190 * PX));
        }
        for p in s.players.iter_mut() {
            p.charges[2] = 50;
            p.charges[3] = 50;
        }
        s
    };
    let mut full = build();
    let mut want = vec![];
    let mut in_flight = 0;
    for t in 1..=300u32 {
        for b in script(&full, t) {
            push(&mut full, b);
        }
        full.step();
        in_flight = in_flight.max(full.projectiles.len());
        if t % 10 == 0 {
            want.push((t, full.state_hash()));
        }
    }
    assert!(in_flight >= 2, "the script must have bolts in flight");
    for &cut in &[14u32, 21, 27, 28, 63, 120, 211] {
        let mut s = build();
        for t in 1..=cut {
            for b in script(&s, t) {
                push(&mut s, b);
            }
            s.step();
        }
        if cut <= 63 {
            assert!(!s.projectiles.is_empty(), "cut {cut} must have bolts in flight");
        }
        let snap = snapshot::write(&s);
        assert_eq!(snap.len(), snapshot::size(&s));
        let mut r = snapshot::restore(&snap).unwrap();
        assert_eq!(r.projectiles, s.projectiles, "cut {cut}");
        assert_eq!(r.state_hash(), s.state_hash(), "cut {cut}");
        let mut got = vec![];
        for t in cut + 1..=300 {
            for b in script(&r, t) {
                push(&mut r, b);
            }
            r.step();
            if t % 10 == 0 {
                got.push((t, r.state_hash()));
            }
        }
        assert_eq!(got, want.iter().filter(|(t, _)| *t > cut).cloned().collect::<Vec<_>>(), "cut {cut}");
    }
}

#[test]
fn hostile_projectile_sections_are_refused() {
    let mut s = arena(1);
    s.projectiles.push(Projectile { owner: 1, spell: 0, cast_seq: 0, x: 0, y: 0, vx: 0, vy: 0, age: 0 });
    let good = snapshot::write(&s);
    assert!(snapshot::restore(&good).is_ok());
    // The projectile count sits 4 bytes before the first projectile; the (empty) bag count, 4 bytes, ends the section.
    let elen_at = 70; // format 4 header
    let elen = u32::from_le_bytes(good[elen_at..elen_at + 4].try_into().unwrap()) as usize;
    let count_at = elen_at + 4 + elen - 4 - PROJECTILE_BYTES - 4;
    let mut bad = good.clone();
    bad[count_at..count_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(snapshot::restore(&bad).is_err());
    let mut bad = good.clone();
    bad[count_at + 4 + 4] = 99; // spell id out of range
    assert!(snapshot::restore(&bad).is_err());
}

/// The sim respawns a player (a test-only path until M5 has deaths): `life` goes up, the position jumps to the
/// spawn point, a `Respawn` event says so, and a Pos with the OLD life is then ignored.
#[test]
fn respawn_changes_life_moves_the_player_and_ignores_stale_pos() {
    let mut s = arena(1);
    place(&mut s, 1, 950, 190);
    s.respawn_player(1);
    assert_eq!(s.players[0].life, 1);
    let ev = s.events.iter().find(|e| e.kind == EV_RESPAWN).copied().unwrap();
    assert_eq!((ev.c, ev.a, ev.b), (1, s.players[0].x, s.players[0].y));
    assert_ne!(s.players[0].x, 950 * PX);
    let at = s.players[0].x;
    push(&mut s, encode_pos(1, 0, 950 * PX, 190 * PX, 0));
    s.step();
    assert_eq!(s.players[0].x, at, "a stale-life Pos cannot drag the player back");
    push(&mut s, encode_pos(1, 1, 950 * PX, 190 * PX, 0));
    s.step();
    assert_eq!(s.players[0].x, 950 * PX);
}

#[test]
fn views_carry_bolts_and_spell_state() {
    let mut s = arena(1);
    push(&mut s, encode_cast(1, 0, RIGHT, 5));
    s.step();
    let mut out = vec![0u8; 80 * ENTITY_BYTES];
    let n = write_view(&s.players, &s.pickups, &s.projectiles, &s.bags, s.tick, &mut out, 80);
    let last = &out[(n - 1) * ENTITY_BYTES..n * ENTITY_BYTES];
    assert_eq!((last[0], u32::from_le_bytes(last[1..5].try_into().unwrap()), last[6]), (ENT_PROJECTILE, 1, 0));
    assert_eq!(u16::from_le_bytes(last[15..17].try_into().unwrap()), 5);
    let mut pv = [0u8; PLAYER_VIEW_BYTES];
    write_player_view(&s.players[0], s.tick, &mut pv);
    assert_eq!(u16::from_le_bytes([pv[0], pv[1]]), INFINITE);
    let left = u16::from_le_bytes([pv[2 * NUM_SPELLS], pv[2 * NUM_SPELLS + 1]]);
    assert!(left > 0 && u32::from(left) <= COOLDOWN[0]);
}

/// Cast flask `spell` straight down in the arena, return (cells of `mat` on the grid afterwards, rock cells lost).
fn flask_down(spell: u8, mat: u8) -> (usize, usize) {
    let mut s = arena(1);
    s.players[0].charges[spell as usize] = 3;
    let rock0 = s.grid.mat.iter().filter(|&&m| m == ROCK).count();
    let m0 = s.grid.mat.iter().filter(|&&m| m == mat).count();
    push(&mut s, encode_cast(1, spell, DOWN, 1));
    s.step();
    run_until(&mut s, 80, |s| s.projectiles.is_empty());
    let n = s.grid.mat.iter().filter(|&&m| m == mat).count();
    (n - m0, rock0 - s.grid.mat.iter().filter(|&&m| m == ROCK).count())
}

#[test]
fn acid_flask_fills_about_fifty_cells_with_acid_capped() {
    let (n, _) = flask_down(ACID_FLASK, ACID);
    assert!(n > 40 && n <= ACID_BURST_CELLS, "acid cells {n}");
}

#[test]
fn oil_flask_fills_seventy_cells_with_oil_capped() {
    let (n, lost) = flask_down(OIL_FLASK, OIL);
    assert!(n > 50 && n <= OIL_BURST_CELLS && lost == 0, "oil cells {n}");
}

#[test]
fn lava_flask_fills_sixty_cells_below_and_around_the_impact() {
    let mut s = arena(1);
    s.players[0].charges[LAVA_FLASK as usize] = 3;
    let before: Vec<bool> = s.grid.mat.iter().map(|&m| m == LAVA).collect();
    push(&mut s, encode_cast(1, LAVA_FLASK, RIGHT, 1));
    s.step();
    let mut at = None;
    // Stop on the impact tick itself: lava flows afterwards, so the disc check needs the fresh burst.
    for _ in 0..80 {
        if let Some(e) = s.events.iter().find(|e| e.kind == EV_IMPACT) {
            at = Some((e.a, e.b));
            break;
        }
        s.step();
    }
    let (ix, iy) = at.expect("impact");
    let lava: Vec<usize> = (0..s.grid.mat.len()).filter(|&i| s.grid.mat[i] == LAVA && !before[i]).collect();
    assert!(lava.len() > 40 && lava.len() <= LAVA_BURST_CELLS, "lava cells {}", lava.len());
    let w = s.grid.w as i32;
    // The sea sits at or below the impact row's neighbourhood: nothing starts more than 6 cells above it.
    assert!(lava.iter().all(|&i| {
        let (dx, dy) = (i as i32 % w - ix, i as i32 / w - iy);
        dx.abs() <= 14 && dy.abs() <= 8 // the burst disc plus one tick of flow
    }));
}

#[test]
fn flasks_are_not_created_by_a_refused_cast() {
    let mut s = arena(1);
    push(&mut s, encode_cast(1, ACID_FLASK, DOWN, 1)); // no charges
    s.step();
    assert!(s.projectiles.is_empty());
}

#[test]
fn wall_places_a_rock_slab_perpendicular_to_the_aim() {
    let mut s = arena(1);
    s.players[0].charges[WALL as usize] = 3;
    let rock0 = s.grid.mat.iter().filter(|&&m| m == ROCK).count();
    push(&mut s, encode_cast(1, WALL, RIGHT, 1));
    s.step();
    let n = s.grid.mat.iter().filter(|&&m| m == ROCK).count() - rock0;
    assert_eq!(n, (WALL_THICK * WALL_LEN) as usize);
    // chest is (1000, 185); the slab is centred WALL_REACH to the right, 12 tall, 3 wide
    let w = s.grid.w;
    for y in 179..191 {
        assert_eq!(s.grid.mat[y * w + 1010], ROCK, "row {y}");
    }
    assert_eq!(s.grid.mat[178 * w + 1010], EMPTY);
    assert_eq!(s.grid.mat[191 * w + 1010], EMPTY);
}

#[test]
fn wall_never_overwrites_bedrock_other_solids_or_a_player() {
    let mut s = arena(2);
    s.players[0].charges[WALL as usize] = 3;
    let w = s.grid.w;
    // bedrock, dirt and a player's hitbox sit in the slab's footprint
    s.grid.mat[178 * w + 1010] = BEDROCK;
    s.grid.mat[179 * w + 1010] = DIRT;
    carved(&mut s);
    place(&mut s, 2, 1010, 190);
    push(&mut s, encode_cast(1, WALL, RIGHT, 1));
    s.step();
    assert_eq!(s.grid.mat[178 * w + 1010], BEDROCK);
    assert_eq!(s.grid.mat[179 * w + 1010], DIRT);
    let b = s.players[1].hitbox_cells();
    for y in b.1..=b.3 {
        for x in b.0..=b.2 {
            assert_ne!(s.grid.mat[y as usize * w + x as usize], ROCK, "player cell {x},{y}");
        }
    }
}

#[test]
fn wall_replaces_liquid_and_is_free_of_projectile_limits() {
    let mut s = arena(1);
    s.players[0].charges[WALL as usize] = 3;
    let w = s.grid.w;
    s.grid.mat[185 * w + 1010] = WATER;
    carved(&mut s);
    push(&mut s, encode_cast(1, WALL, RIGHT, 1));
    s.step();
    assert_eq!(s.grid.mat[185 * w + 1010], ROCK);
    assert!(s.projectiles.is_empty());
}

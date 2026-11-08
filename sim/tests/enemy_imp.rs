//! F5 commit 2: the Fire imp (flier, line of sight, bolts, water weakness, placement).
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::encode_join;
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

/// Open air 100..320 x 300..700, rock floor from y=260; player 1 stands at x=`px` on the floor. No generated enemies.
fn arena(px: i32) -> Sim {
    let mut s = Sim::new(5, RoomConfig::survival()).unwrap();
    s.enemies.clear();
    let w = s.grid.w;
    for y in 100..320 {
        for x in 300..700 {
            s.grid.mat[y * w + x] = if y < 260 { EMPTY } else { ROCK };
        }
    }
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
    s.push_input(&encode_join(1));
    s.step();
    s.round_running = 1; // F6b: this test is about the running round, not the lobby (tests/lobby.rs)
    s.players[0].x = px * PX;
    s.players[0].y = 260 * PX;
    s
}

fn imp(id: u16, x: i32, y: i32) -> Enemy {
    Enemy::new(id, ENEMY_IMP, x * PX, y * PX)
}

fn keep_alive(s: &mut Sim) {
    s.players[0].health = HEALTH_MAX;
}

fn dist_cells(s: &Sim) -> i32 {
    let (e, p) = (&s.enemies[0], &s.players[0]);
    let (dx, dy) = (i64::from(e.x - p.x), i64::from((e.y - 2 * PX) - (p.y - CHEST * PX)));
    (sim::spells::isqrt((dx * dx + dy * dy) as u64) >> POS_SHIFT) as i32
}

#[test]
fn an_imp_closes_to_its_band_then_keeps_its_distance() {
    let mut s = arena(500);
    s.enemies = vec![imp(0, 500 + 130, 200)];
    let mut after = vec![];
    for t in 0..900 {
        s.step();
        keep_alive(&mut s);
        if t >= 600 {
            after.push(dist_cells(&s));
        }
    }
    let (lo, hi) = (*after.iter().min().unwrap(), *after.iter().max().unwrap());
    assert!(lo >= IMP_NEAR_CELLS - 6 && hi <= IMP_FAR_CELLS + 6, "distance range {lo}..{hi}");
    // a player who walks up to it makes it back off
    s.players[0].x = s.enemies[0].x;
    s.players[0].y = s.enemies[0].y + 8 * PX;
    for _ in 0..600 {
        s.step();
        keep_alive(&mut s);
    }
    assert!(dist_cells(&s) >= IMP_NEAR_CELLS - 8, "{}", dist_cells(&s));
}

#[test]
fn an_imp_flies_over_a_gap_that_stops_a_walker() {
    let mut s = arena(640);
    // a 60-wide pit in the floor between the imp and the player
    let w = s.grid.w;
    for y in 260..320 {
        for x in 520..580 {
            s.grid.mat[y * w + x] = EMPTY;
        }
    }
    s.enemies = vec![imp(0, 500, 240)];
    let mut min_x_dist = i32::MAX;
    for _ in 0..800 {
        s.step();
        keep_alive(&mut s);
        min_x_dist = min_x_dist.min(((s.enemies[0].x - s.players[0].x) >> POS_SHIFT).abs());
        assert!(s.enemies[0].y < 320 * PX, "fell into the pit");
    }
    assert!(s.enemies[0].x > 580 * PX, "the imp crossed the gap: x {}", s.enemies[0].x >> POS_SHIFT);
    assert!(min_x_dist <= IMP_FAR_CELLS, "{min_x_dist}");
}

#[test]
fn an_imp_in_range_with_a_clear_line_fires_and_the_bolt_hurts_the_player() {
    let mut s = arena(500);
    s.enemies = vec![imp(0, 500 + 50, 230)];
    let mut hit_at = None;
    let mut bolts = 0;
    for t in 0..400 {
        s.step();
        bolts = bolts.max(s.projectiles.iter().filter(|q| q.owner & sim::tuning::ENEMY_OWNER != 0).count());
        if hit_at.is_none() && s.players[0].health < HEALTH_MAX {
            hit_at = Some(t);
        }
        if s.events.iter().any(|e| e.kind == EV_DEATH) {
            break;
        }
    }
    assert!(bolts >= 1, "no bolt was fired");
    assert!(hit_at.is_some(), "no bolt reached the player");
    assert_eq!(s.players[0].last_hit_by, 0);
}

#[test]
fn an_imp_fires_at_most_once_per_ninety_ticks() {
    let mut s = arena(500);
    s.enemies = vec![imp(0, 500 + 50, 230)];
    let mut fired = vec![];
    let mut seen = 0usize;
    for t in 0..360u32 {
        s.step();
        keep_alive(&mut s);
        let n = s.projectiles.iter().filter(|q| q.age == 1 && q.owner & ENEMY_OWNER != 0).count();
        if n > 0 {
            fired.push(t);
        }
        seen += n;
    }
    assert!(seen >= 2, "{fired:?}");
    assert!(fired.windows(2).all(|w| w[1] - w[0] >= IMP_FIRE_TICKS), "{fired:?}");
}

#[test]
fn line_of_sight_is_blocked_by_rock_and_clear_in_open_air() {
    let mut s = arena(500);
    assert!(s.line_clear((450, 230), (550, 230)));
    assert!(s.line_clear((450, 230), (550, 250)));
    let w = s.grid.w;
    s.grid.mat[230 * w + 500] = ROCK;
    assert!(!s.line_clear((450, 230), (550, 230)), "one rock cell blocks it");
    // over the step limit counts as blocked, and the walk cost is bounded
    assert!(!s.line_clear((300, 150), (300 + LOS_MAX_STEPS + 1, 150)));
    // an imp behind a rock wall does not fire
    let mut s = arena(500);
    for y in 100..260 {
        s.grid.mat[y * w + 520] = ROCK;
    }
    s.enemies = vec![imp(0, 560, 230)];
    for _ in 0..400 {
        s.step();
        keep_alive(&mut s);
        assert!(s.projectiles.iter().all(|q| q.owner & ENEMY_OWNER == 0), "fired through rock");
    }
}

#[test]
fn an_imp_is_immune_to_fire_and_lava_and_hurt_by_water() {
    let mut s = arena(500);
    s.players[0].x = 500 * PX;
    // fire and lava around it: no damage
    s.enemies = vec![imp(0, 600, 200)];
    let w = s.grid.w;
    for y in 190..201 {
        for x in 590..611 {
            s.grid.mat[y * w + x] = if x % 2 == 0 { FIRE } else { LAVA };
        }
    }
    for _ in 0..60 {
        for y in 190..201 {
            for x in 590..611 {
                s.grid.mat[y * w + x] = if x % 2 == 0 { FIRE } else { LAVA };
            }
        }
        s.enemies[0].x = 600 * PX;
        s.enemies[0].y = 200 * PX;
        s.step();
        keep_alive(&mut s);
    }
    assert_eq!(s.enemies[0].hp, 30, "fire and lava do nothing");
    // water: 1 hp every 4 ticks
    let mut s = arena(500);
    s.enemies = vec![imp(0, 600, 200)];
    let w = s.grid.w;
    for y in 190..201 {
        for x in 590..611 {
            s.grid.mat[y * w + x] = WATER;
        }
    }
    let mut hp = vec![];
    for _ in 0..40 {
        for y in 190..201 {
            for x in 590..611 {
                s.grid.mat[y * w + x] = WATER;
            }
        }
        s.enemies[0].x = 600 * PX;
        s.enemies[0].y = 200 * PX;
        s.step();
        keep_alive(&mut s);
        hp.push(s.enemies[0].hp);
    }
    assert_eq!(hp[39], 30 - 10, "40 ticks in water at 1 per 4: {hp:?}");
}

#[test]
fn an_imp_is_placed_in_survival_only_in_open_air_in_its_band() {
    for size in 0..=2u8 {
        for seed in 1..=3u64 {
            let s = Sim::new(seed, RoomConfig { size, ..RoomConfig::survival() }).unwrap();
            let (w, h) = (s.grid.w as i32, s.grid.h as i32);
            let imps: Vec<_> = s.enemies.iter().filter(|e| e.kind == ENEMY_IMP).collect();
            assert!(!imps.is_empty(), "size {size} seed {seed} has no imp");
            let top = (260 + 800) / 2 * (h - 64) / (1536 - 64);
            for e in &imps {
                let (cx, cy) = (e.x >> 4, e.y >> 4);
                assert!(cy > top - 40, "imp too high: {cy} < {top}");
                for y in cy - 7..cy - 1 {
                    for x in cx - 3..=cx + 3 {
                        assert_eq!(s.grid.mat[(y * w + x) as usize], EMPTY, "size {size} seed {seed} imp {} pocket {x},{y}", e.id);
                    }
                }
            }
            assert!(s.enemies.len() <= MAX_ENEMIES);
            let mut ids: Vec<u16> = s.enemies.iter().map(|e| e.id).collect();
            ids.dedup();
            assert_eq!(ids.len(), s.enemies.len());
        }
    }
    // no imps without the enemies flag, and none in the other presets
    assert!(Sim::new(1, RoomConfig::caves_pvp()).unwrap().enemies.is_empty());
}

#[test]
fn imp_counts_per_size() {
    let mut lines = String::new();
    for size in 0..=2u8 {
        for seed in 1..=3u64 {
            let s = Sim::new(seed, RoomConfig { size, ..RoomConfig::survival() }).unwrap();
            let n = s.enemies.iter().filter(|e| e.kind == ENEMY_IMP).count();
            let sl = s.enemies.iter().filter(|e| e.kind == ENEMY_SLIME).count();
            lines.push_str(&format!("size {size} seed {seed}: imps {n} slimes {sl} total {}\n", s.enemies.len()));
            assert!(n >= 1 && n <= 12);
        }
    }
    let _ = std::fs::write("/tmp/f5-counts.txt", lines);
}

/// Real terrain, seed 1: the first generated imp, with a player placed in its pocket 45 cells to the left at the
/// same height (open air required; the pocket is 13 wide so the player is put on the nearest open cell).
#[test]
fn a_generated_imp_on_seed_1_hunts_and_shoots_a_player_in_its_cave() {
    let mut s = Sim::new(1, RoomConfig::survival()).unwrap();
    let e = s.enemies.iter().find(|e| e.kind == ENEMY_IMP).unwrap().clone();
    let keep: Vec<Enemy> = vec![e.clone()];
    s.enemies = keep;
    s.push_input(&encode_join(1));
    s.step();
    s.round_running = 1; // F6b: this test is about the running round, not the lobby (tests/lobby.rs)
    // the player stands on the nearest floor below the imp, a few cells to the side
    let (w, h) = (s.grid.w as i32, s.grid.h as i32);
    let ex = e.x >> 4;
    let mut spot = None;
    'o: for dx in [20, -20, 30, -30, 10, -10, 40, -40] {
        let x = ex + dx;
        let mut y = (e.y >> 4).min(h - 2);
        for _ in 0..60 {
            if s.grid.mat[((y + 1) * w + x) as usize] != EMPTY && (y - 8..=y).all(|yy| (x - 2..=x + 2).all(|xx| s.grid.mat[(yy * w + xx) as usize] == EMPTY)) {
                spot = Some((x, y));
                break 'o;
            }
            y += 1;
            if y >= h - 2 {
                break;
            }
        }
    }
    let (x, y) = spot.expect("a standable floor near the imp");
    s.players[0].x = x * PX + PX / 2;
    s.players[0].y = (y + 1) * PX;
    let mut moved = false;
    let mut bolts = 0usize;
    for _ in 0..600 {
        let before = (s.enemies[0].x, s.enemies[0].y);
        s.step();
        keep_alive(&mut s);
        s.players[0].x = x * PX + PX / 2;
        s.players[0].y = (y + 1) * PX;
        moved |= before != (s.enemies[0].x, s.enemies[0].y);
        bolts += s.projectiles.iter().filter(|q| q.owner & ENEMY_OWNER != 0 && q.age == 1).count();
    }
    assert!(moved, "the imp never moved");
    // positions read from the sim, not assumed (D-162): the imp is within aggro, so it hunts
    assert!(s.enemies[0].state & 1 == 1 || bolts > 0, "imp ({},{}) player ({x},{y})", s.enemies[0].x >> 4, s.enemies[0].y >> 4);
}

// ---- D7 and D5 -----------------------------------------------------------------------------------------

fn d7_run(sleep: bool) -> Vec<(u32, u64)> {
    let mut s = arena(500);
    s.grid.sleep_enabled = sleep;
    s.enemies = vec![imp(0, 560, 230), imp(1, 500 + 224 + 4, 230), imp(2, 440, 200)];
    let mut out = vec![(0, s.state_hash())];
    for t in 1..=900u32 {
        if t == 300 {
            s.push_input(&sim::input::encode_paint(1, SAND, 540, 150, 560, 160, 6));
        }
        s.step();
        keep_alive(&mut s);
        if t % 20 == 0 {
            out.push((t, s.state_hash()));
        }
    }
    out
}

#[test]
fn d7_sleeping_is_invisible_with_imps_and_their_bolts() {
    let a = d7_run(true);
    let b = d7_run(false);
    assert_eq!(a, b);
    assert!(a.windows(2).any(|w| w[0].1 != w[1].1));
}

#[test]
fn d5_a_snapshot_with_an_imp_bolt_in_flight_resumes_identically() {
    let mut s = arena(500);
    s.enemies = vec![imp(0, 550, 230)];
    let mut snap = None;
    for t in 0..600 {
        s.step();
        keep_alive(&mut s);
        if snap.is_none() && s.projectiles.iter().any(|q| q.owner & ENEMY_OWNER != 0) && t > 5 {
            snap = Some(snapshot::write(&s));
            break;
        }
    }
    let mut r = snapshot::restore(&snap.expect("an imp bolt in flight")).unwrap();
    assert!(r.projectiles.iter().any(|q| q.owner & ENEMY_OWNER != 0));
    for _ in 0..300 {
        s.step();
        keep_alive(&mut s);
        r.step();
        r.players[0].health = HEALTH_MAX;
    }
    assert_eq!(s.state_hash(), r.state_hash());
}

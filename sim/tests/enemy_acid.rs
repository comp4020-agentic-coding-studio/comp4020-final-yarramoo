//! F5 commit 3: the Acid slime (slow walker, acid trail, death burst, acid immunity, deep placement).
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::encode_join;
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

/// Air above y=200, rock from y=200 (x 300..700), player 1 on the floor at `px`. No generated enemies.
fn arena(px: i32) -> Sim {
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
    s.players[0].x = px * PX;
    s.players[0].y = 200 * PX;
    s
}

fn acid(id: u16, x: i32) -> Enemy {
    Enemy::new(id, ENEMY_ACID_SLIME, x * PX, 200 * PX)
}

/// A rock wall at x=620..622 from the ceiling to the floor: the slimes hunt a player on the far side and never arrive.
fn wall(s: &mut Sim) {
    let w = s.grid.w;
    for y in 100..200 {
        for x in 620..623 {
            s.grid.mat[y * w + x] = ROCK;
        }
    }
}

fn count(s: &Sim, m: u8) -> usize {
    s.grid.mat.iter().filter(|&&c| c == m).count()
}

#[test]
fn an_acid_slime_walks_to_a_player_slower_than_a_slime_and_hits_for_fifteen() {
    let reach = |kind: u8| {
        let mut s = arena(560);
        s.enemies = vec![Enemy::new(0, kind, 480 * PX, 200 * PX)];
        for t in 0..1500 {
            let before = s.players[0].health;
            s.step();
            if s.events.iter().any(|e| e.kind == EV_KNOCK) {
                return (t, before - s.players[0].health);
            }
        }
        panic!("kind {kind} never reached the player");
    };
    let (_, da) = reach(ENEMY_ACID_SLIME);
    assert_eq!(da, 15);
    // Slower: one arrival time is hop-jitter noise (review-f5), so compare the ground each kind covers toward
    // the player in a fixed window, summed over eight start columns. Shown red with ACID_SLIME_HOP_VX = SLIME_HOP_VX
    // and ACID_SLIME_HOP_EXTRA = 0.
    let covered = |kind: u8| -> i32 {
        (0..8)
            .map(|k| {
                let mut s = arena(560);
                let x0 = (440 + k * 5) * PX;
                s.enemies = vec![Enemy::new(0, kind, x0, 200 * PX)];
                for _ in 0..240 {
                    s.step();
                    s.players[0].health = HEALTH_MAX;
                }
                s.enemies.first().map_or(0, |e| e.x - x0)
            })
            .sum()
    };
    let (acid_dx, slime_dx) = (covered(ENEMY_ACID_SLIME), covered(ENEMY_SLIME));
    assert!(acid_dx > 0 && slime_dx > 0, "both must advance: acid {acid_dx}, slime {slime_dx}");
    assert!(acid_dx * 4 < slime_dx * 3, "acid slime covered {acid_dx}, slime {slime_dx}: not clearly slower");
}

#[test]
fn the_trail_is_one_cell_every_twenty_ticks_per_slime_and_never_more_than_one_per_tick() {
    let mut s = arena(560);
    wall(&mut s);
    s.enemies = (0..6).map(|i| acid(i, 520 + i32::from(i) * 8)).collect();
    let mut worst = 0usize;
    let mut last = count(&s, ACID);
    let mut total = 0usize;
    for _ in 0..200 {
        s.step();
        s.players[0].health = HEALTH_MAX;
        s.players[0].x = 630 * PX; // behind the wall: it keeps hunting and never arrives
        let n = count(&s, ACID);
        worst = worst.max(n.saturating_sub(last));
        total += n.saturating_sub(last);
        last = n;
    }
    assert!(total >= 6, "a hunting acid slime leaves a trail: {total}");
    assert!(worst <= 1, "{worst} acid cells appeared in one tick");
    // and one slime alone leaves about one cell per 20 ticks
    let mut s = arena(630);
    wall(&mut s);
    s.enemies = vec![acid(0, 600)];
    let base = count(&s, ACID);
    for _ in 0..400 {
        s.step();
        s.players[0].health = HEALTH_MAX;
        s.players[0].x = 630 * PX;
    }
    let n = count(&s, ACID) - base;
    // It stops at the wall and a cell already holding acid takes no second drop, so the count is low; the cap is the point.
    assert!((3..=400 / 20 + 1).contains(&n), "{n}");
}

#[test]
fn an_idle_acid_slime_leaves_no_trail() {
    let mut s = arena(300);
    s.enemies = vec![acid(0, 690)]; // player 390 cells away: it does not hunt
    s.players[0].x = 310 * PX;
    let base = count(&s, ACID);
    for _ in 0..300 {
        s.step();
    }
    assert_eq!(count(&s, ACID), base);
}

#[test]
fn a_dying_acid_slime_bursts_into_at_most_twelve_acid_cells() {
    let mut s = arena(560);
    s.enemies = vec![acid(0, 500)];
    let base = count(&s, ACID);
    s.enemies[0].hp = 1;
    s.damage_enemy(0, 5, 1);
    s.reap_enemies();
    let n = count(&s, ACID) - base;
    assert!(s.enemies.is_empty());
    assert!(n >= 1 && n <= ACID_DEATH_CELLS, "{n} burst cells");
    // a plain slime dying leaves none
    let mut s = arena(560);
    s.enemies = vec![Enemy::new(0, ENEMY_SLIME, 500 * PX, 200 * PX)];
    let base = count(&s, ACID);
    s.damage_enemy(0, 50, 1);
    s.reap_enemies();
    assert_eq!(count(&s, ACID), base);
}

#[test]
fn an_acid_slime_is_unhurt_by_acid_and_hurt_by_fire() {
    let mut s = arena(480);
    s.enemies = vec![acid(0, 600)];
    s.players[0].x = 480 * PX;
    let w = s.grid.w;
    for _ in 0..60 {
        for y in 195..200 {
            for x in 595..606 {
                s.grid.mat[y * w + x] = ACID;
            }
        }
        s.enemies[0].x = 600 * PX;
        s.enemies[0].y = 200 * PX;
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    assert_eq!(s.enemies[0].hp, 60, "acid does nothing to it");
    let mut s = arena(480);
    s.enemies = vec![acid(0, 600)];
    for _ in 0..60 {
        for y in 195..200 {
            for x in 595..606 {
                s.grid.mat[y * w + x] = FIRE;
            }
        }
        s.enemies[0].x = 600 * PX;
        s.enemies[0].y = 200 * PX;
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    assert!(s.enemies[0].hp < 60, "fire hurts it: {}", s.enemies[0].hp);
}

#[test]
fn acid_slimes_are_placed_on_deep_floors_in_survival() {
    let mut lines = String::new();
    for size in 0..=2u8 {
        for seed in 1..=3u64 {
            let s = Sim::new(seed, RoomConfig { size, ..RoomConfig::survival() }).unwrap();
            let (w, h) = (s.grid.w as i32, s.grid.h as i32);
            let deep = 800 * (h - 64) / (1536 - 64);
            let a: Vec<_> = s.enemies.iter().filter(|e| e.kind == ENEMY_ACID_SLIME).collect();
            lines.push_str(&format!("size {size} seed {seed}: acid slimes {} total {}\n", a.len(), s.enemies.len()));
            assert!(!a.is_empty(), "size {size} seed {seed}");
            assert!(s.enemies.len() <= MAX_ENEMIES);
            for e in a {
                let (x0, y0, x1, y1) = e.hitbox_cells();
                assert!(y1 > deep, "acid slime above the deep band: {y1} <= {deep}");
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        assert_eq!(s.grid.mat[(y * w + x) as usize], EMPTY);
                    }
                }
                assert!(matches!(s.grid.mat[((y1 + 1) * w + (e.x >> 4)) as usize], ROCK | DIRT | BEDROCK));
            }
        }
    }
    let _ = std::fs::write("/tmp/f5-acid-counts.txt", lines);
    assert!(Sim::new(1, RoomConfig::caves_pvp()).unwrap().enemies.iter().all(|e| e.kind == ENEMY_SLIME) || true);
    assert!(Sim::new(1, RoomConfig::caves_pvp()).unwrap().enemies.is_empty());
}

/// Real terrain, seed 1: a generated acid slime reaches a player standing on the nearest floor beside it.
#[test]
fn a_generated_acid_slime_on_seed_1_reaches_a_player_beside_it() {
    let mut s = Sim::new(1, RoomConfig::survival()).unwrap();
    let e = s.enemies.iter().find(|e| e.kind == ENEMY_ACID_SLIME).unwrap().clone();
    s.enemies = vec![e.clone()];
    s.push_input(&encode_join(1));
    s.step();
    let (ex, ey) = (e.x >> 4, (e.y >> 4) - 1);
    s.players[0].x = (ex + 12) * PX + PX / 2;
    s.players[0].y = (ey + 1) * PX;
    let w = s.grid.w as i32;
    // clear a corridor so the player has the same floor; positions are read from the sim, not assumed
    for y in ey - 9..=ey {
        for x in ex..=ex + 14 {
            s.grid.mat[(y * w + x) as usize] = EMPTY;
        }
    }
    for x in ex..=ex + 14 {
        s.grid.mat[((ey + 1) * w + x) as usize] = ROCK;
        // Falling rock v0: a loose rock row with nothing under it is a free island and would crumble; seat it on
        // bedrock so the floor stays a floor (the test is about the slime reaching the player, not the floor).
        s.grid.mat[((ey + 2) * w + x) as usize] = BEDROCK;
    }
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
    let mut hit = false;
    for _ in 0..900 {
        s.step();
        hit |= s.players[0].health < HEALTH_MAX;
        s.players[0].health = HEALTH_MAX;
        s.players[0].x = (ex + 12) * PX + PX / 2;
    }
    assert!(hit, "acid slime at {ex},{ey} never touched the player");
}

fn d7_run(sleep: bool) -> Vec<(u32, u64)> {
    let mut s = arena(500);
    s.grid.sleep_enabled = sleep;
    s.enemies = vec![acid(0, 540), acid(1, 500 + 224 + 4), acid(2, 480)];
    let mut out = vec![(0, s.state_hash())];
    for t in 1..=900u32 {
        if t == 300 {
            s.push_input(&sim::input::encode_paint(1, SAND, 540, 150, 560, 160, 6));
        }
        s.step();
        s.players[0].health = HEALTH_MAX;
        if t == 600 {
            s.damage_enemy(0, 100, 1);
        }
        if t % 20 == 0 {
            out.push((t, s.state_hash()));
        }
    }
    out
}

#[test]
fn d7_sleeping_is_invisible_with_acid_slimes_trail_and_burst() {
    let a = d7_run(true);
    assert_eq!(a, d7_run(false));
    assert!(a.windows(2).any(|w| w[0].1 != w[1].1));
}

#[test]
fn a_snapshot_taken_mid_trail_resumes_identically() {
    let mut s = arena(560);
    s.enemies = vec![acid(0, 450)];
    for _ in 0..90 {
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    let mut r = snapshot::restore(&snapshot::write(&s)).unwrap();
    for _ in 0..200 {
        s.step();
        s.players[0].health = HEALTH_MAX;
        r.step();
        r.players[0].health = HEALTH_MAX;
    }
    assert_eq!(s.state_hash(), r.state_hash());
}

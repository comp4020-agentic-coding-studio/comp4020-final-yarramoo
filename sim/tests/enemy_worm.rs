//! F5 commit 4: the Burrower worm (dormant in rock, tunnels toward a player, contact, lava, placement, D7/D5).
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::encode_join;
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const PX: i32 = POS_ONE;

/// Solid rock 100..320 x 300..700 with an open corridor y 250..260 on the far right (x 640..700); player 1 stands
/// there at `px` (floor row 260). No generated enemies.
fn rock_arena(px: i32) -> Sim {
    let mut s = Sim::new(5, RoomConfig::survival()).unwrap();
    s.enemies.clear();
    let w = s.grid.w;
    // The generated world's own acid pools would eat Rock and move the global Rock count these tests assert on.
    for m in s.grid.mat.iter_mut() {
        if *m == ACID {
            *m = EMPTY;
        }
    }
    for y in 100..320 {
        for x in 300..700 {
            s.grid.mat[y * w + x] = ROCK;
        }
    }
    for y in 240..260 {
        for x in 600..700 {
            s.grid.mat[y * w + x] = EMPTY;
        }
    }
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
    s.push_input(&encode_join(1));
    s.step();
    s.round_started |= ROUND_RUNNING; // F6b: this test is about the running round, not the lobby (tests/lobby.rs)
    s.players[0].x = px * PX;
    s.players[0].y = 260 * PX;
    s
}

/// A worm whose body bottom row is `y` (centre two rows above).
fn worm(id: u16, x: i32, y: i32) -> Enemy {
    Enemy::new(id, ENEMY_WORM, x * PX + PX / 2, y * PX)
}

fn keep_alive(s: &mut Sim) {
    s.players[0].health = HEALTH_MAX;
}

fn centre(s: &Sim) -> (i32, i32) {
    (s.enemies[0].x >> 4, (s.enemies[0].y - 2 * PX) >> 4)
}

fn solid(s: &Sim, x: i32, y: i32) -> bool {
    s.grid.mat[y as usize * s.grid.w + x as usize] == ROCK
}

#[test]
fn a_worm_stays_dormant_and_buried_until_a_player_is_within_forty_cells() {
    let mut s = rock_arena(690);
    s.enemies = vec![worm(0, 500, 250)];
    let start = (s.enemies[0].x, s.enemies[0].y);
    let rock_before = s.grid.mat.iter().filter(|&&m| m == ROCK).count();
    for _ in 0..300 {
        s.step();
        keep_alive(&mut s);
    }
    assert_eq!((s.enemies[0].x, s.enemies[0].y), start, "a dormant worm does not move");
    assert_eq!(s.enemies[0].state & 1, 0);
    assert_eq!(s.grid.mat.iter().filter(|&&m| m == ROCK).count(), rock_before, "a dormant worm digs nothing");
    // 39 cells away wakes it
    s.players[0].x = (500 + 39) * PX;
    s.players[0].y = 250 * PX;
    s.step();
    assert_eq!(s.enemies[0].state & 1, 1, "awake");
}

#[test]
fn an_awake_worm_tunnels_toward_the_player_digging_a_radius_three_tunnel() {
    let mut s = rock_arena(600);
    s.enemies = vec![worm(0, 600 - 35, 250)];
    let (x0, y0) = centre(&s);
    for _ in 0..800 {
        s.players[0].x = 600 * PX;
        s.step();
        keep_alive(&mut s);
    }
    let (x1, y1) = centre(&s);
    assert!(x1 > x0 + 12, "tunnelled right: {x0} -> {x1}");
    assert!((y1 - y0).abs() < 12);
    // the tunnel along the start row is open (the worm dug it) and about 7 cells across; the rock beside it is intact
    let mid = (x0 + x1) / 2;
    assert!(!solid(&s, mid, y0), "open on the start row at {mid},{y0}");
    assert!(!solid(&s, mid, y0 - 3) && !solid(&s, mid, y0 + 3), "radius 3 reaches 3 rows either side");
    assert!(solid(&s, mid, y0 - 5) && solid(&s, mid, y0 + 5), "the tunnel is not wider than its radius");
}

#[test]
fn a_worm_that_breaks_into_the_player_hits_for_twenty() {
    let mut s = rock_arena(615);
    s.enemies = vec![worm(0, 590, 252)];
    let mut dmg = 0;
    for _ in 0..1200 {
        let before = s.players[0].health;
        s.step();
        if s.players[0].health < before {
            dmg = before - s.players[0].health;
            break;
        }
    }
    assert_eq!(dmg, 20);
}

#[test]
fn a_worm_is_hurt_by_lava_and_not_immune() {
    assert_eq!(ENEMY_STATS[usize::from(ENEMY_WORM)].immune, 0);
    let mut s = rock_arena(690);
    s.enemies = vec![worm(0, 650, 250)];
    s.enemies[0].state = 1;
    s.players[0].x = 640 * PX;
    let w = s.grid.w;
    for _ in 0..40 {
        for y in 244..252 {
            for x in 645..656 {
                s.grid.mat[y * w + x] = LAVA;
            }
        }
        s.step();
        keep_alive(&mut s);
        if s.enemies.is_empty() {
            break;
        }
    }
    assert!(s.enemies.is_empty() || s.enemies[0].hp < 90);
}

#[test]
fn a_worm_never_digs_bedrock_or_leaves_the_world() {
    let mut s = rock_arena(690);
    let w = s.grid.w;
    for y in 100..320 {
        for x in 450..455 {
            s.grid.mat[y * w + x] = BEDROCK;
        }
    }
    s.enemies = vec![worm(0, 430, 250)];
    s.enemies[0].state = 1;
    for _ in 0..900 {
        s.step();
        keep_alive(&mut s);
    }
    assert!(s.enemies[0].x < 450 * PX, "bedrock stops it: {}", s.enemies[0].x >> 4);
    assert!((450..455).all(|x| s.grid.mat[250 * w + x] == BEDROCK));
}

#[test]
fn a_worm_that_reaches_a_pool_does_not_remove_the_liquid() {
    let mut s = rock_arena(560);
    let w = s.grid.w;
    for y in 240..262 {
        for x in 500..520 {
            s.grid.mat[y * w + x] = WATER;
        }
    }
    s.enemies = vec![worm(0, 470, 250)];
    s.enemies[0].state = 1;
    for _ in 0..500 {
        s.players[0].x = 560 * PX;
        s.step();
        keep_alive(&mut s);
    }
    // dig leaves liquid cells; the pool is intact where the worm has passed through it (water may flow into the tunnel)
    assert!(s.grid.mat.iter().filter(|&&m| m == WATER).count() > 0);
    assert!(s.enemies[0].x > 505 * PX, "it tunnelled through the pool: {}", s.enemies[0].x >> 4);
}

#[test]
fn worm_work_per_tick_is_bounded() {
    let mut s = rock_arena(690);
    // the player sits in the middle of the row so all 24 (the stepping cap) are inside the rectangle and awake
    s.enemies = (0..24).map(|i| worm(i, 330 + i32::from(i) * 8, 250)).collect();
    for e in s.enemies.iter_mut() {
        e.state = 1;
    }
    let mut worst = 0;
    for _ in 0..200 {
        s.players[0].x = 430 * PX;
        s.step();
        keep_alive(&mut s);
        worst = worst.max(s.enemy_work);
    }
    let _ = std::fs::write("/tmp/f5-worm-work.txt", format!("24 worms awake: worst {worst} cells/tick\n"));
    // 24 stepped worms x one radius-3 dig box (7 x 7 cells) each: the bound is exact, so halving it fails.
    assert_eq!(worst, 24 * 49, "{worst}");
}

#[test]
fn worms_appear_buried_in_deep_rock_in_survival_only() {
    let mut lines = String::new();
    for size in 0..=2u8 {
        for seed in 1..=3u64 {
            let s = Sim::new(seed, RoomConfig { size, ..RoomConfig::survival() }).unwrap();
            let (w, h) = (s.grid.w as i32, s.grid.h as i32);
            let deep = 800 * (h - 64) / (1536 - 64);
            let ws: Vec<_> = s.enemies.iter().filter(|e| e.kind == ENEMY_WORM).collect();
            lines.push_str(&format!("size {size} seed {seed}: worms {} total {}\n", ws.len(), s.enemies.len()));
            assert!(!ws.is_empty(), "size {size} seed {seed}");
            assert!(s.enemies.len() <= MAX_ENEMIES);
            for e in ws {
                let (cx, cy) = (e.x >> 4, (e.y - 2 * PX) >> 4);
                assert!(cy > deep);
                assert_eq!(e.state, 0, "dormant");
                for y in cy - WORM_BURIED_CELLS..=cy + WORM_BURIED_CELLS {
                    for x in cx - WORM_BURIED_CELLS..=cx + WORM_BURIED_CELLS {
                        assert_eq!(s.grid.mat[(y * w + x) as usize], ROCK, "size {size} seed {seed} worm {} not buried at {x},{y}", e.id);
                    }
                }
            }
        }
    }
    let _ = std::fs::write("/tmp/f5-worm-counts.txt", lines);
    assert!(Sim::new(1, RoomConfig::caves_pvp()).unwrap().enemies.is_empty());
}

#[test]
fn a_generated_worm_on_seed_1_wakes_and_tunnels_toward_a_player_beside_it() {
    let mut s = Sim::new(1, RoomConfig::survival()).unwrap();
    let e = s.enemies.iter().find(|e| e.kind == ENEMY_WORM).unwrap().clone();
    s.enemies = vec![e.clone()];
    s.push_input(&encode_join(1));
    s.step();
    s.round_started |= ROUND_RUNNING; // F6b: this test is about the running round, not the lobby (tests/lobby.rs)
    let (cx, cy) = (e.x >> 4, (e.y - 2 * PX) >> 4);
    // the player stands in a carved pocket 30 cells to the right of the worm (positions read from the sim)
    let w = s.grid.w as i32;
    let px = cx + 30;
    for y in cy - 8..=cy {
        for x in px - 3..=px + 3 {
            s.grid.mat[(y * w + x) as usize] = EMPTY;
        }
    }
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
    s.players[0].x = px * PX;
    s.players[0].y = (cy + 1) * PX;
    let mut hit = false;
    for _ in 0..1500 {
        s.step();
        hit |= s.players[0].health < HEALTH_MAX;
        keep_alive(&mut s);
        s.players[0].x = px * PX;
        s.players[0].y = (cy + 1) * PX;
        if hit {
            break;
        }
    }
    assert_eq!(s.enemies[0].state & 1, 1);
    assert!(hit, "worm at {cx},{cy} never reached the player at {px},{cy}; now at {:?}", centre(&s));
}

// ---- D7 and D5 -----------------------------------------------------------------------------------------

fn d7_run(sleep: bool) -> Vec<(u32, u64)> {
    let mut s = rock_arena(600);
    s.grid.sleep_enabled = sleep;
    // the worm tunnels through rock that is asleep (settled) when it arrives; one more sits just outside the rectangle
    s.enemies = vec![worm(0, 565, 250), worm(1, 600 + 224 + 4, 250)];
    let mut out = vec![(0, s.state_hash())];
    for t in 1..=900u32 {
        s.step();
        keep_alive(&mut s);
        if t == 400 {
            s.push_input(&sim::input::encode_paint(1, WATER, 560, 245, 570, 255, 5));
        }
        if t % 20 == 0 {
            out.push((t, s.state_hash()));
        }
    }
    out
}

#[test]
fn d7_sleeping_is_invisible_with_a_worm_tunnelling_through_a_sleeping_chunk() {
    // The rock is the settled mass: with sleeping on, some chunk is asleep while the worm digs.
    let mut s = rock_arena(600);
    s.enemies = vec![worm(0, 565, 250)];
    let mut asleep = 0;
    for _ in 0..600 {
        s.step();
        keep_alive(&mut s);
        asleep = asleep.max(s.grid.awake.iter().filter(|&&a| !a).count());
    }
    assert!(asleep > 0, "no chunk slept while the worm dug");
    let a = d7_run(true);
    assert_eq!(a, d7_run(false));
    assert!(a.windows(2).any(|w| w[0].1 != w[1].1));
}

#[test]
fn d5_a_snapshot_mid_tunnel_resumes_identically() {
    let mut s = rock_arena(600);
    s.enemies = vec![worm(0, 565, 250)];
    for _ in 0..100 {
        s.players[0].x = 600 * PX;
        s.step();
        keep_alive(&mut s);
    }
    let x_mid = s.enemies[0].x;
    assert!(x_mid > 565 * PX + PX / 2 && s.enemies[0].state & 1 == 1);
    let mut r = snapshot::restore(&snapshot::write(&s)).unwrap();
    for _ in 0..200 {
        s.step();
        keep_alive(&mut s);
        r.step();
        r.players[0].health = HEALTH_MAX;
    }
    assert_eq!(s.state_hash(), r.state_hash());
    assert!(s.enemies[0].x > x_mid);
}

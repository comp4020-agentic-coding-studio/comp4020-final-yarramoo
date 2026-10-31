//! F4 commit 4: the stepping rule, the slime AI, contact damage, the embedded rescue, and D7 with slimes.
use sim::config::RoomConfig;
use sim::entities::*;
use sim::input::{encode_join, encode_pos};
use sim::materials::*;
use sim::sim::Sim;
use sim::tuning::*;

const PX: i32 = POS_ONE;

/// A Survival world with its generated slimes removed and a flat arena: air above y=200, rock from y=200 down
/// (x 300..700), players placed by the caller. Floor row is 200, so feet sit at y=200.
fn arena(players: &[(u32, i32)]) -> Sim {
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
    for &(id, _) in players {
        assert_eq!(s.push_input(&encode_join(id)), 0);
    }
    s.step();
    for &(id, x) in players {
        let k = s.players.iter().position(|p| p.id == id).unwrap();
        s.players[k].x = x * PX;
        s.players[k].y = 200 * PX;
    }
    s
}

fn slime(id: u16, x: i32, y: i32) -> Enemy {
    Enemy::new(id, ENEMY_SLIME, x * PX, y * PX)
}

#[test]
fn an_enemy_inside_the_rectangle_steps_and_one_outside_is_frozen() {
    let mut s = arena(&[(1, 500)]);
    // inside: 100 cells right of the player (rectangle half-width 224); outside: 230 cells right.
    s.enemies = vec![slime(0, 600, 150), slime(1, 500 + ENEMY_ACTIVE_W / 2 + 6, 150)];
    let before = s.enemies.clone();
    s.step();
    assert_ne!(s.enemies[0], before[0], "the near slime fell");
    assert_eq!(s.enemies[1], before[1], "the far slime is frozen by rule");
    // exactly on the edge steps, one unit past does not
    let mut s = arena(&[(1, 500)]);
    s.enemies = vec![slime(0, 500 + ENEMY_ACTIVE_W / 2, 150), slime(1, 500 + ENEMY_ACTIVE_W / 2 + 1, 150)];
    let before = s.enemies.clone();
    s.step();
    assert_ne!(s.enemies[0], before[0], "on the edge");
    assert_eq!(s.enemies[1], before[1], "one cell past the edge");
}

#[test]
fn only_the_lowest_ids_step_when_more_than_the_cap_are_in_range() {
    let mut s = arena(&[(1, 500)]);
    s.enemies = (0..30u16).map(|i| slime(i, 400 + i32::from(i) * 10, 150)).collect();
    let before = s.enemies.clone();
    s.step();
    for i in 0..30 {
        assert_eq!(s.enemies[i] != before[i], i < MAX_ENEMIES_STEPPED, "enemy {i}");
    }
}

#[test]
fn a_dead_or_absent_player_wakes_nothing() {
    let mut s = arena(&[(1, 500)]);
    s.enemies = vec![slime(0, 520, 150)];
    s.players[0].health = 0;
    s.players[0].dead_until = u32::MAX;
    let before = s.enemies.clone();
    s.step();
    assert_eq!(s.enemies, before);
}

#[test]
fn targeting_breaks_a_distance_tie_toward_the_lowest_id() {
    // Player 2 stands left, player 1 right, both 60 cells away: a tie, so the slime hops toward id 1 (right).
    for (left, right, expect_right) in [(2u32, 1u32, true), (1, 2, false)] {
        let mut s = arena(&[(1, 0), (2, 0)]);
        for p in s.players.iter_mut() {
            p.x = (if p.id == left { 440 } else { 560 }) * PX;
        }
        let _ = right;
        s.enemies = vec![slime(0, 500, 200)];
        for _ in 0..3 {
            s.step();
        }
        let e = &s.enemies[0];
        assert!(e.hop_until > 0, "it hopped");
        assert_eq!(e.x > 500 * PX, expect_right, "left={left}: x={}", e.x);
    }
}

#[test]
fn a_slime_hops_toward_a_player_lands_and_does_not_enter_rock() {
    let mut s = arena(&[(1, 560)]);
    s.enemies = vec![slime(0, 500, 200)];
    for _ in 0..600 {
        s.step();
        let e = &s.enemies[0];
        let (x0, y0, x1, y1) = e.hitbox_cells();
        for y in y0..=y1 {
            for x in x0..=x1 {
                assert_eq!(s.grid.mat[y as usize * s.grid.w + x as usize], EMPTY, "embedded at {x},{y} tick {}", s.tick);
            }
        }
        // keep the player alive and still so the test is about movement
        s.players[0].health = HEALTH_MAX;
    }
    let e = &s.enemies[0];
    assert!(e.x > 520 * PX, "it travelled toward the player: {}", e.x);
    assert!(e.y <= 200 * PX);
}

#[test]
fn contact_damage_is_eight_with_a_forty_tick_cooldown_and_a_knock() {
    let mut s = arena(&[(1, 500)]);
    s.enemies = vec![slime(0, 500, 200)];
    s.step();
    assert_eq!(s.players[0].health, HEALTH_MAX - 8);
    assert!(s.events.iter().any(|ev| ev.kind == EV_KNOCK && ev.player == 1 && ev.a != 0));
    let t0 = s.tick;
    let mut hits = vec![t0];
    for _ in 0..90 {
        let h = s.players[0].health;
        s.step();
        if s.players[0].health < h {
            hits.push(s.tick);
        }
        // hold the pair together
        s.players[0].x = s.enemies[0].x;
        s.players[0].y = s.enemies[0].y;
    }
    assert_eq!(hits[1] - hits[0], 40, "hits at {hits:?}");
    assert_eq!(hits[2] - hits[1], 40);
}

#[test]
fn an_embedded_slime_is_rescued_upward_and_the_sim_does_not_diverge() {
    let mut s = arena(&[(1, 500)]);
    s.enemies = vec![slime(0, 520, 200)];
    // Rock fills the slime's body (a dig and refill, or a paint): it sits inside the floor.
    for y in 196..200 {
        for x in 516..525 {
            s.grid.mat[y * s.grid.w + x] = ROCK;
        }
    }
    s.step();
    let e = &s.enemies[0];
    assert!(e.y < 196 * PX, "moved above the rock: y={}", e.y / PX);
    let (x0, y0, x1, y1) = e.hitbox_cells();
    for y in y0..=y1 {
        for x in x0..=x1 {
            assert_eq!(s.grid.mat[y as usize * s.grid.w + x as usize], EMPTY);
        }
    }
    // buried deeper than the rescue reach: it stays put and nothing panics
    let mut s = arena(&[(1, 500)]);
    s.enemies = vec![slime(0, 520, 280)];
    for _ in 0..10 {
        s.step();
    }
    assert_eq!(s.enemies.len(), 1);
}

#[test]
fn material_classes_match_names_ts() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../shared/names.ts")).unwrap();
    let at = src.find("MATERIAL_CLASS").unwrap();
    let body = &src[at..];
    let body = &body[body.find('[').unwrap()..];
    let body = &body[..body.find("];").unwrap()];
    let classes: Vec<u8> = body
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let q = l.strip_prefix('"')?;
            Some(match &q[..q.find('"')?] {
                "empty" => CLASS_EMPTY,
                "solid" => CLASS_SOLID,
                "liquid" => CLASS_LIQUID,
                "gas" => CLASS_GAS,
                other => panic!("class {other}"),
            })
        })
        .collect();
    assert_eq!(classes.len(), 21);
    for (m, &c) in classes.iter().enumerate() {
        assert_eq!(material_class(m as u8), c, "material {m}");
    }
}

// ---- D7: sleeping is invisible with enemies about --------------------------------------------------------

fn d7_run(sleep: bool) -> Vec<(u32, u64)> {
    let mut s = arena(&[(1, 500)]);
    s.grid.sleep_enabled = sleep;
    // near, just outside the rectangle, and straddling its edge (centre 500, half-width 224: x=724 is on it)
    s.enemies = vec![slime(0, 540, 200), slime(1, 500 + 224 + 4, 200), slime(2, 500 + 224, 200), slime(3, 480, 200)];
    let mut out = vec![(0, s.state_hash())];
    for t in 1..=900u32 {
        if t == 300 {
            // disturb: sand and water drop into a settled region, a hole opens under a slime
            s.push_input(&sim::input::encode_paint(1, SAND, 540, 150, 560, 160, 6));
        }
        if t == 500 {
            s.push_input(&encode_pos(1, 0, 700 * PX, 200 * PX, 0));
        }
        s.step();
        if s.players[0].health < 50 {
            s.players[0].health = HEALTH_MAX;
        }
        if t % 20 == 0 {
            out.push((t, s.state_hash()));
        }
    }
    out
}

#[test]
fn d7_sleeping_is_invisible_with_slimes_near_outside_and_straddling() {
    let a = d7_run(true);
    let b = d7_run(false);
    assert_eq!(a, b);
    assert!(a.windows(2).any(|w| w[0].1 != w[1].1));
}

#[test]
fn enemy_work_is_bounded_and_measured() {
    let mut s = arena(&[(1, 500)]);
    s.enemies = (0..MAX_ENEMIES as u16).map(|i| slime(i, 380 + i32::from(i) * 5, 200)).collect();
    let mut worst = 0;
    let mut total = 0u64;
    for _ in 0..300 {
        s.step();
        worst = worst.max(s.enemy_work);
        total += u64::from(s.enemy_work);
        s.players[0].health = HEALTH_MAX;
    }
    let _ = std::fs::write("/tmp/f4-enemy-work.txt", format!("48 slimes, 24 stepped: worst {worst} cells/tick, mean {} cells/tick\n", total / 300));
    // 24 enemies x (a few 5x4 tests per move step, up to a few dozen tests): well under 24 * 400 cells
    assert!(worst < 24 * 400, "{worst}");
}

// ---- fix pass: slopes ------------------------------------------------------------------------------------

/// Rock rises one cell per column from x=520 (a 45-degree slope going right); the slime starts at its foot and the
/// player stands at the top. The slime must climb it and reach contact.
fn slope_world(rise_per_col: usize) -> Sim {
    let mut s = arena(&[(1, 500)]);
    let w = s.grid.w;
    for x in 520..600 {
        let h = ((x - 520) * rise_per_col).min(40);
        for y in (200 - h)..200 {
            s.grid.mat[y * w + x] = ROCK;
        }
    }
    s.players[0].x = 575 * PX;
    s.players[0].y = (200 - 40) * PX;
    s.enemies = vec![slime(0, 510, 200)];
    s
}

#[test]
fn a_slime_climbs_a_45_degree_slope_and_reaches_a_player_at_the_top() {
    for rise in [1usize, 2] {
        let mut s = slope_world(rise);
        let mut hit_at = None;
        for t in 0..900 {
            s.step();
            if s.players[0].health < HEALTH_MAX {
                hit_at = Some(t);
                break;
            }
        }
        assert!(hit_at.is_some(), "rise {rise}: the slime never reached the player; it is at x={} y={}", s.enemies[0].x / PX, s.enemies[0].y / PX);
    }
}

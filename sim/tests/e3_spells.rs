//! E3: Mud, Salt, Snow, Thermite and the Freeze, Quake and Mudslide spells.
use sim::grid::Grid;
use sim::input::{encode_cast, encode_join};
use sim::materials::*;
use sim::sim::Sim;
use sim::tuning::*;

const N: usize = 256;

fn fill(g: &mut Grid, x0: usize, y0: usize, x1: usize, y1: usize, m: u8) {
    for y in y0..y1 {
        for x in x0..x1 {
            g.mat[y * N + x] = m;
        }
    }
}
fn count(g: &Grid, m: u8) -> usize {
    g.mat.iter().filter(|&&c| c == m).count()
}
fn run(g: &mut Grid, ticks: u32) {
    for t in 0..ticks {
        g.step_cells(7, t);
    }
}
fn floor() -> Grid {
    let mut g = Grid::new(N, N);
    fill(&mut g, 0, 200, N, 204, ROCK);
    g
}

#[test]
fn ids_and_rules() {
    assert_eq!((MUD, SALT, SNOW, THERMITE), (22, 23, 24, 25));
    for m in [MUD, SALT, SNOW, THERMITE] {
        assert!(paintable(m));
        assert_eq!(material_class(m), CLASS_SOLID);
        assert!(!sim::grid::is_structural(m));
    }
    assert!(!paintable(26));
    assert_eq!(BAG_SPELL_IDS.len(), BAG_SPELLS);
}

#[test]
fn mud_is_slower_than_sand_and_dries_beside_fire() {
    let mut g = floor();
    g.set(50 * N + 100, MUD, 0);
    g.set(50 * N + 120, SAND, 0);
    run(&mut g, 60);
    let y_of = |g: &Grid, m: u8, x: usize| (0..N).find(|&y| g.mat[y * N + x] == m).unwrap();
    assert!(y_of(&g, MUD, 100) < y_of(&g, SAND, 120), "mud falls slower");
    run(&mut g, 400);
    assert_eq!(g.mat[199 * N + 100], MUD);
    g.set(198 * N + 101, FIRE, 0);
    run(&mut g, 5);
    assert_eq!(g.mat[199 * N + 100], DIRT, "dries to dirt");
}

#[test]
fn salt_melts_ice_and_dissolves_in_water() {
    let mut g = floor();
    fill(&mut g, 100, 199, 110, 200, ICE);
    for x in 100..110 {
        g.set(198 * N + x, SALT, 0);
    }
    run(&mut g, 300);
    assert!(count(&g, ICE) <= 4, "salt melts ice, got {}", count(&g, ICE));
    assert!(count(&g, WATER) >= 5);
    let mut g = floor();
    fill(&mut g, 100, 195, 101, 199, WATER);
    fill(&mut g, 99, 195, 100, 199, ROCK);
    fill(&mut g, 101, 195, 102, 199, ROCK);
    g.set(190 * N + 100, SALT, 0);
    run(&mut g, 400);
    assert_eq!(count(&g, SALT), 0, "salt dissolved");
}

#[test]
fn snow_melts_near_lava_and_packs_to_ice_under_weight() {
    let mut g = floor();
    g.set(198 * N + 100, SNOW, 0);
    g.set(199 * N + 101, LAVA, 0);
    run(&mut g, 20);
    assert_eq!(count(&g, SNOW), 0);
    let mut g = floor();
    fill(&mut g, 100, 150, 101, 199, SNOW); // a tall column in a 1-wide gap
    fill(&mut g, 99, 150, 100, 200, ROCK);
    fill(&mut g, 101, 150, 102, 200, ROCK);
    run(&mut g, 600);
    assert!(count(&g, ICE) >= 5, "packed ice, got {}", count(&g, ICE));
    assert!(count(&g, SNOW) >= 3, "the top stays snow");
}

#[test]
fn thermite_needs_a_light_then_burns_through_rock() {
    let mut g = floor();
    fill(&mut g, 90, 190, 110, 200, ROCK);
    g.set(189 * N + 100, THERMITE, 0);
    run(&mut g, 200);
    assert_eq!(count(&g, LAVA), 0, "unlit thermite does nothing");
    g.set(188 * N + 101, FIRE, 0);
    run(&mut g, 200);
    assert!(count(&g, LAVA) >= 1, "lit thermite melts rock");
}

fn arena() -> Sim {
    let mut s = Sim::new(11, 1).unwrap();
    let w = s.grid.w;
    for y in 100..260 {
        for x in 900..1150 {
            s.grid.mat[y * w + x] = if y < 192 { EMPTY } else if y < 194 { ROCK } else { BEDROCK };
        }
    }
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
    assert_eq!(s.push_input(&encode_join(1)), 0);
    s.step();
    s.players[0].x = 1000 * POS_ONE;
    s.players[0].y = 190 * POS_ONE;
    s
}
fn cast(s: &mut Sim, spell: u8, angle: u16) {
    s.players[0].charges[spell as usize] = 5;
    assert_eq!(s.push_input(&encode_cast(1, spell, angle, 1)), 0);
    s.step();
}
fn cells(s: &Sim, m: u8) -> usize {
    s.grid.mat.iter().filter(|&&c| c == m).count()
}

#[test]
fn freeze_turns_a_bounded_amount_of_water_to_ice() {
    let mut s = arena();
    let w = s.grid.w;
    for y in 150..192 {
        for x in 1010..1060 {
            s.grid.mat[y * w + x] = WATER;
        }
    }
    let before = cells(&s, WATER);
    cast(&mut s, 12, 0); // along +x, hits the water
    for _ in 0..40 {
        s.step();
    }
    let ice = cells(&s, ICE);
    assert!(ice >= 10 && ice <= FREEZE_CAP, "ice {ice}");
    assert!(cells(&s, WATER) + ice <= before + 1000);
    assert_eq!(s.players[0].charges[12], 4);
}

#[test]
fn quake_crumbles_a_bounded_patch_of_rock() {
    let mut s = arena();
    let w = s.grid.w;
    for y in 175..192 {
        for x in 1000..1040 {
            s.grid.mat[y * w + x] = ROCK;
        }
    }
    let before = cells(&s, ROCK);
    cast(&mut s, 13, 0);
    let after = cells(&s, ROCK);
    assert!(before - after <= (2 * QUAKE_R as usize + 1).pow(2), "bounded");
    assert!(cells(&s, PEBBLES) >= 5, "pebbles {}", cells(&s, PEBBLES));
}

#[test]
fn mudslide_fills_a_bounded_burst_with_mud() {
    let mut s = arena();
    cast(&mut s, 14, 16384);
    for _ in 0..30 {
        s.step();
    }
    let m = cells(&s, MUD) + cells(&s, DIRT);
    assert!(m >= 20 && m <= MUD_BURST_CELLS, "mud {m}");
}

#[test]
fn new_spells_are_deterministic_and_sleep_invisible() {
    let go = |sleep: bool| {
        let mut s = arena();
        s.grid.sleep_enabled = sleep;
        let w = s.grid.w;
        for y in 160..192 {
            for x in 1010..1040 {
                s.grid.mat[y * w + x] = if x % 3 == 0 { WATER } else { SNOW };
            }
        }
        let mut hs = vec![];
        for (k, sp) in [12u8, 13, 14, 12].into_iter().enumerate() {
            cast(&mut s, sp, 0);
            for _ in 0..150 {
                s.step();
                hs.push(s.state_hash());
            }
            let _ = k;
        }
        hs
    };
    assert_eq!(go(true), go(true));
    assert_eq!(go(true), go(false));
}

#[test]
fn new_materials_sleep_is_invisible() {
    use sim::input::encode_paint;
    let go = |sleep: bool| {
        let mut s = Sim::new(13, 0).unwrap();
        s.grid.sleep_enabled = sleep;
        let script: Vec<(u32, Vec<u8>)> = vec![
            (1, encode_paint(1, 2, 200, 300, 330, 300, 2)),
            (2, encode_paint(1, SNOW, 230, 250, 280, 280, 5)),
            (2, encode_paint(1, MUD, 300, 250, 320, 280, 4)),
            (2, encode_paint(1, ICE, 205, 295, 215, 298, 2)),
            (3, encode_paint(1, SALT, 205, 285, 215, 290, 3)),
            (400, encode_paint(1, THERMITE, 255, 240, 262, 240, 3)),
            (450, encode_paint(1, FIRE, 258, 236, 259, 236, 1)),
            (500, encode_paint(1, WATER, 300, 200, 310, 210, 4)),
        ];
        let mut out = vec![];
        for t in 1..=900u32 {
            for (_, b) in script.iter().filter(|(tt, _)| *tt == t) {
                assert_eq!(s.push_input(b), 0);
            }
            s.step();
            if t % 10 == 0 {
                out.push(s.state_hash());
            }
        }
        out
    };
    assert_eq!(go(true), go(false));
}

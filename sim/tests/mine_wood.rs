//! The old mine must actually place its wood: over seeds 1..=32 at M and L (Survival preset), most worlds have a mine
//! with at least 2 beams (vertical Wood runs of 8+ rows) standing on ground. Playtest 6 Nov: wood almost never appeared.
use sim::config::RoomConfig;
use sim::gen::{generate_world, BIOME_MINE};
use sim::grid::Grid;
use sim::materials::*;

fn stands(m: u8) -> bool {
    matches!(m, ROCK | DIRT | BEDROCK | SAND | BRICK | COAL | WOOD | MOSS)
}

/// (worlds, worlds with a mine, worlds with >=2 beams, total beams) for one size.
fn survey(size: u8) -> (u32, u32, u32, u32) {
    let (mut worlds, mut with_mine, mut ok, mut total) = (0, 0, 0, 0);
    for seed in 1..=32u64 {
        let cfg = RoomConfig { size, ..RoomConfig::survival() };
        let (w, h) = cfg.dims();
        let mut g = Grid::new(w, h);
        let world = generate_world(&mut g, seed, true);
        let (gw, gh) = (g.w as i32, g.h as i32);
        let at = |x: i32, y: i32| g.mat[(y * gw + x) as usize];
        worlds += 1;
        let mut beams = 0;
        let mut mine = false;
        for s in world.sites.iter().filter(|s| s.kind == BIOME_MINE) {
            mine = true;
            for x in (s.cx - s.rx).max(1)..=(s.cx + s.rx).min(gw - 2) {
                for y in (s.cy - s.ry - 4).max(1)..=(s.cy + s.ry + 30).min(gh - 3) {
                    if at(x, y) != WOOD || at(x, y - 1) == WOOD || !s.inside(x, y) {
                        continue;
                    }
                    let mut b = y;
                    while at(x, b + 1) == WOOD {
                        b += 1;
                    }
                    if b - y + 1 >= 8 && stands(at(x, b + 1)) {
                        beams += 1;
                    }
                }
            }
        }
        with_mine += mine as u32;
        ok += (beams >= 2) as u32;
        total += beams;
    }
    (worlds, with_mine, ok, total)
}

#[test]
fn most_worlds_have_a_mine_with_standing_beams() {
    let mut out = String::new();
    let mut bad = Vec::new();
    for size in [1u8, 2] {
        let (n, m, ok, beams) = survey(size);
        out += &format!("size {size}: worlds {n} with mine {m} >=2 beams {ok} total beams {beams}\n");
        if ok * 4 < n * 3 {
            bad.push(size);
        }
    }
    std::fs::write("/tmp/mine-wood-survey.txt", &out).unwrap();
    assert!(bad.is_empty(), "under 75% of worlds have 2+ standing mine beams at sizes {bad:?}:\n{out}");
}

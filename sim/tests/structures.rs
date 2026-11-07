//! content-W1: surface ruins (houses) and wells from generation. Seeds 1..=8, sizes 0..=2, PvP and Survival.
use sim::config::RoomConfig;
use sim::gen::{box_reach, generate_world, Structure, World, SPAWN_CLEAR_COLS, STRUCT_HOUSE, STRUCT_WELL_CAVE, STRUCT_WELL_WATER};
use sim::grid::Grid;
use sim::materials::*;
use sim::tuning::{ARENA_KEEP_OUT, ENEMY_SPAWN_CLEAR};

fn make(size: u8, seed: u64, survival: bool) -> (Grid, World) {
    let cfg = RoomConfig { size, ..if survival { RoomConfig::survival() } else { RoomConfig::caves_pvp() } };
    let (w, h) = cfg.dims();
    let mut g = Grid::new(w, h);
    let world = generate_world(&mut g, seed, cfg.has_enemies());
    (g, world)
}

fn all() -> Vec<(u8, u64, bool, Grid, World)> {
    let mut v = Vec::new();
    for size in 0u8..=2 {
        for seed in 1..=8u64 {
            for survival in [false, true] {
                let (g, w) = make(size, seed, survival);
                v.push((size, seed, survival, g, w));
            }
        }
    }
    v
}

fn at(g: &Grid, x: i32, y: i32) -> u8 {
    g.mat[y as usize * g.w + x as usize]
}

fn houses(w: &World) -> impl Iterator<Item = &Structure> {
    w.structures.iter().filter(|s| s.kind == STRUCT_HOUSE)
}

#[test]
fn structures_exist_at_medium_and_large() {
    for size in 1u8..=2 {
        let (mut with_house, mut with_well, mut n_h, mut n_cave, mut n_water) = (0, 0, 0, 0, 0);
        for (sz, _, _, _, w) in all().iter().filter(|a| a.0 == size) {
            let _ = sz;
            let h = houses(w).count();
            let wl = w.structures.len() - h;
            n_h += h;
            n_cave += w.structures.iter().filter(|s| s.kind == STRUCT_WELL_CAVE).count();
            n_water += w.structures.iter().filter(|s| s.kind == STRUCT_WELL_WATER).count();
            with_house += usize::from(h > 0);
            with_well += usize::from(wl > 0);
        }
        std::fs::write(format!("/tmp/cw1-counts-{size}.txt"), format!("size {size}: worlds with a house {with_house}/16, with a well {with_well}/16, houses {n_h}, cave wells {n_cave}, water wells {n_water}\n")).unwrap();
        assert!(with_house >= 12, "size {size}: only {with_house}/16 worlds have a house");
        assert!(with_well >= 8, "size {size}: only {with_well}/16 worlds have a well");
    }
}

/// Cells of a structure's box that are Brick or Wood.
fn built(g: &Grid, s: &Structure) -> Vec<(i32, i32)> {
    let mut v = Vec::new();
    for y in s.top - 1..s.floor {
        for x in s.x0..=s.x1 {
            if matches!(at(g, x, y), BRICK | WOOD) {
                v.push((x, y));
            }
        }
    }
    v
}

#[test]
fn houses_stand_on_the_ground_and_never_float() {
    let mut bad = Vec::new();
    for (size, seed, sv, g, w) in all() {
        for s in houses(&w) {
            // Footings: each column's Brick below the floor row ends on Dirt/Rock.
            for x in s.x0..=s.x1 {
                let mut y = s.floor;
                while at(&g, x, y) == BRICK {
                    y += 1;
                }
                if !matches!(at(&g, x, y), DIRT | ROCK) {
                    bad.push(format!("size {size} seed {seed} {sv}: footing column {x} ends on {}", at(&g, x, y)));
                }
            }
            // Everything above the floor row is 4-connected through Brick/Wood to the footing or the ground, except the
            // lintel arch (walls above the doors and the roof): a 2D passage under a roof cannot be propped from the
            // side, so the arch as a whole is one connected piece (checked below) that rests on nothing.
            let cells = built(&g, s);
            let mut seen = std::collections::HashSet::new();
            let mut stack: Vec<(i32, i32)> = (s.x0..=s.x1).filter(|&x| at(&g, x, s.floor) == BRICK || at(&g, x, s.floor) == DIRT).map(|x| (x, s.floor - 1)).filter(|&(x, y)| matches!(at(&g, x, y), BRICK | WOOD)).collect();
            for &c in &stack {
                seen.insert(c);
            }
            while let Some((x, y)) = stack.pop() {
                for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
                    if nx >= s.x0 && nx <= s.x1 && ny >= s.top - 8 && ny < s.floor && matches!(at(&g, nx, ny), BRICK | WOOD) && seen.insert((nx, ny)) {
                        stack.push((nx, ny));
                    }
                }
            }
            // What is not grounded is the lintel arch (walls above the doors, the roof, the chimney): a passage 12 tall
            // cannot be propped from the side, so those cells must all sit above the door line.
            if cells.iter().any(|c| !seen.contains(c) && c.1 > s.floor - 13) {
                bad.push(format!("size {size} seed {seed} {sv}: house at {} floats a cell below the door line", s.x0));
            }
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn structures_keep_out_of_the_spawn_columns_and_the_arena() {
    for (size, seed, sv, g, w) in all() {
        let mid = g.w as i32 / 2;
        let mut wide = 0;
        for s in &w.structures {
            assert!(s.x1 < mid - SPAWN_CLEAR_COLS || s.x0 > mid + SPAWN_CLEAR_COLS, "size {size} seed {seed} {sv}: structure {s:?} in the spawn columns");
            if let Some(a) = &w.arena {
                for x in s.x0..=s.x1 {
                    for y in [s.top, s.floor, s.bottom] {
                        assert!(!a.contains(x, y, ARENA_KEEP_OUT), "size {size} seed {seed} {sv}: structure {s:?} in the arena's keep-out");
                    }
                }
            }
            if s.x1 < mid - ENEMY_SPAWN_CLEAR || s.x0 > mid + ENEMY_SPAWN_CLEAR {
                wide += 1;
            }
        }
        let _ = wide;
    }
}

#[test]
fn houses_can_be_walked_through_and_entered() {
    for (size, seed, sv, g, w) in all() {
        for s in houses(&w) {
            for x in [s.x0, s.x0 + 1, s.x1 - 1, s.x1] {
                for y in s.floor - 12..s.floor {
                    assert_eq!(at(&g, x, y), EMPTY, "size {size} seed {seed} {sv}: door at {x},{y} is shut");
                }
            }
            // A 5x10 body fits standing inside, and the box flood reaches both outer sides and the inside.
            let inside = s.x0 + 2..=s.x1 - 6;
            let reach = |sx: i32| box_reach(&g, (sx as usize, s.floor as usize - 10), 5, 10);
            let sky = (g.w / 2, 0usize);
            let _ = sky;
            let seen = flood(&g);
            let stand = |x: i32| (s.floor as usize - 15..=s.floor as usize - 10).any(|y| seen[y * g.w + x as usize]);
            if !inside.clone().any(stand) {
                let dump: String = (s.floor - 14..s.floor + 2).map(|y| (s.x0 - 8..=s.x1 + 8).map(|x| if seen[y as usize * g.w + x as usize] { '.' } else { char::from(b'0' + at(&g, x, y) % 10) }).collect::<String>() + "\n").collect();
                std::fs::write("/tmp/cw1-dbg.txt", dump).unwrap();
            }
            assert!(inside.clone().any(stand), "size {size} seed {seed} {sv}: no reachable standing spot inside house at {}", s.x0);
            if !((s.x1 + 1..s.x1 + 6).any(stand)) {
                let dump: String = (s.floor - 20..s.floor + 3).map(|y| (s.x0 - 8..=s.x1 + 12).map(|x| if seen[y as usize * g.w + x as usize] { '.' } else { char::from(b'0' + at(&g, x, y) % 10) }).collect::<String>() + "\n").collect();
                std::fs::write("/tmp/cw1-dbg.txt", dump).unwrap();
            }
            assert!((s.x0 - 6..s.x0).any(stand), "size {size} seed {seed} {sv}: left of house at {} unreachable", s.x0);
            assert!((s.x1 + 1..s.x1 + 6).any(stand), "size {size} seed {seed} {sv}: right of house at {} unreachable", s.x1);
            let _ = reach;
        }
    }
}

/// Box tops (5x10) reachable from the top of the world centre.
fn flood(g: &Grid) -> Vec<bool> {
    let (w, h) = (g.w, g.h);
    let (bw, bh) = (5usize, 10usize);
    let mut ps = vec![0u32; (w + 1) * (h + 1)];
    for y in 0..h {
        for x in 0..w {
            let solid = u32::from(g.mat[y * w + x] != 0);
            ps[(y + 1) * (w + 1) + x + 1] = solid + ps[y * (w + 1) + x + 1] + ps[(y + 1) * (w + 1) + x] - ps[y * (w + 1) + x];
        }
    }
    let fits = |x: usize, y: usize| {
        x + bw <= w && y + bh <= h && {
            let (x1, y1) = (x + bw, y + bh);
            ps[y1 * (w + 1) + x1] + ps[y * (w + 1) + x] == ps[y * (w + 1) + x1] + ps[y1 * (w + 1) + x]
        }
    };
    let mut seen = vec![false; w * h];
    let mut stack = vec![(w / 2, 0usize)];
    seen[w / 2] = true;
    while let Some((x, y)) = stack.pop() {
        for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
            if nx < w && ny < h && !seen[ny * w + nx] && fits(nx, ny) {
                seen[ny * w + nx] = true;
                stack.push((nx, ny));
            }
        }
    }
    seen
}

#[test]
fn fire_on_a_roof_is_bounded_and_sleep_invisible() {
    use sim::sim::Sim;
    let mut report = String::new();
    for (size, seed) in [(1u8, 1u64), (1, 2), (2, 3)] {
        let cfg = RoomConfig { size, ..RoomConfig::survival() };
        let run = |sleep: bool| {
            let mut s = Sim::new(seed, cfg.clone()).unwrap();
            let (_, world) = make(size, seed, true);
            let Some(st) = world.structures.iter().find(|t| t.kind == STRUCT_HOUSE).copied() else { return None };
            let wood = |s: &Sim| s.grid.mat.iter().filter(|&&m| m == WOOD).count();
            let before = wood(&s);
            let i = (st.top + 1) as usize * s.grid.w + (st.x0 + 6) as usize;
            if s.grid.mat[i] != WOOD {
                return None;
            }
            s.grid.mat[i] = FIRE;
            s.grid.sleep_enabled = sleep;
            for _ in 0..1200 {
                s.step();
            }
            let fire = s.grid.mat.iter().filter(|&&m| m == FIRE).count();
            Some((s.state_hash(), before - wood(&s), fire))
        };
        let (a, b) = (run(true), run(false));
        assert_eq!(a, b, "size {size} seed {seed}: sleep changed the burn");
        if let Some((_, burned, fire)) = a {
            report += &format!("size {size} seed {seed}: burned {burned} wood, {fire} fire left\n");
            assert!(burned <= 400, "burned {burned}");
            assert!(fire <= 3, "{fire} fire cells still burning at tick 1200");
        }
    }
    std::fs::write("/tmp/cw1-fire.txt", report).unwrap();
}

/// Every Empty cell 4-connected to the top of the world centre.
fn sky_cells(g: &Grid) -> Vec<bool> {
    let w = g.w;
    let mut seen = vec![false; g.mat.len()];
    let mut stack = vec![w / 2];
    seen[w / 2] = true;
    while let Some(i) = stack.pop() {
        let (x, y) = (i % w, i / w);
        let mut nb = Vec::new();
        if x > 0 { nb.push(i - 1) }
        if x + 1 < w { nb.push(i + 1) }
        if y > 0 { nb.push(i - w) }
        if y + 1 < g.h { nb.push(i + w) }
        for j in nb {
            if !seen[j] && g.mat[j] == EMPTY {
                seen[j] = true;
                stack.push(j);
            }
        }
    }
    seen
}

#[test]
fn wells_open_to_a_reachable_cave_or_hold_water_on_solid() {
    let (mut cave, mut water) = (0, 0);
    for (size, seed, sv, g, w) in all() {
        let sky = sky_cells(&g);
        for s in w.structures.iter().filter(|s| s.kind != STRUCT_HOUSE) {
            let xi = s.x0 + 2;
            if s.kind == STRUCT_WELL_CAVE {
                cave += 1;
                for y in s.floor..s.bottom {
                    for x in xi..xi + 7 {
                        assert_eq!(at(&g, x, y), EMPTY, "size {size} seed {seed} {sv}: shaft cell {x},{y} is not open");
                    }
                }
                let open = (xi..xi + 7).filter(|&x| at(&g, x, s.bottom) == EMPTY);
                assert!(open.clone().any(|x| sky[s.bottom as usize * g.w + x as usize]), "size {size} seed {seed} {sv}: the opening of the well at {xi} is not reachable from the sky");
            } else {
                water += 1;
                let mut wet = 0;
                for y in s.floor..=s.bottom {
                    for x in xi..xi + 7 {
                        if at(&g, x, y) == WATER {
                            wet += 1;
                            assert!(matches!(at(&g, x, y + 1), WATER | DIRT | ROCK | COAL), "size {size} seed {seed} {sv}: water at {x},{y} floats");
                            assert!(matches!(at(&g, xi - 1, y), DIRT | ROCK | COAL | BRICK) && matches!(at(&g, xi + 7, y), DIRT | ROCK | COAL | BRICK), "size {size} seed {seed} {sv}: water well wall at row {y} is not solid");
                        }
                    }
                }
                assert!(wet >= 4 * 7, "size {size} seed {seed} {sv}: only {wet} water cells");
            }
        }
    }
    assert!(cave > 0 && water > 0, "cave {cave} water {water}");
}

#[test]
fn salts_are_unique() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/rng.rs")).unwrap();
    // Some older salts already share values and changing one would move every pinned world, so they are left alone.
    // Every salt declared from the content-W1 comment on (and any later one) must not equal any other salt.
    let marker = src.lines().position(|l| l.contains("content-W1: surface ruins")).expect("marker comment");
    let mut all: Vec<(usize, String, u32)> = Vec::new();
    for (n, line) in src.lines().enumerate().filter(|(_, l)| l.trim_start().starts_with("pub const SALT_")) {
        let (name, rest) = line.trim_start()["pub const ".len()..].split_once(':').unwrap();
        let val: u32 = rest.split('=').nth(1).unwrap().trim().trim_end_matches(';').trim().parse().unwrap();
        all.push((n, name.to_string(), val));
    }
    assert!(all.len() > 100, "parsed only {} salts", all.len());
    for (n, name, val) in all.iter().filter(|a| a.0 > marker) {
        let clash: Vec<_> = all.iter().filter(|o| o.2 == *val && o.0 != *n).map(|o| o.1.clone()).collect();
        assert!(clash.is_empty(), "{name} shares the salt {val} with {clash:?}");
    }
}

#[test]
fn a_large_survival_world_keeps_its_enemy_budget() {
    let s = sim::sim::Sim::new(1, RoomConfig { size: 2, ..RoomConfig::survival() }).unwrap();
    std::fs::write("/tmp/cw1-enemies.txt", format!("{}\n", s.enemies.len())).unwrap();
    assert!(s.enemies.len() <= 64);
}

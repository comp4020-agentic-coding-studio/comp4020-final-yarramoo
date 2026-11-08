//! Every pickup can be walked into: some feet position has the 5x10 body free of solids while the pickup cell is
//! inside the sim's pickup test (hitbox cells, plus `PICKUP_REACH_BELOW` below the feet). Solid is the avatar's rule
//! (client/avatar.ts `isSolid`): not Empty, not gas, not liquid.
use sim::config::RoomConfig;
use sim::materials::{is_gas, is_liquid};
use sim::sim::Sim;
use sim::tuning::{HITBOX_H, HITBOX_W, PICKUP_REACH_BELOW, POS_ONE};

fn reachable(s: &Sim, kx: i32, ky: i32) -> bool {
    let (w, h) = (s.grid.w as i32, s.grid.h as i32);
    let solid = |x: i32, y: i32| {
        if x < 0 || y < 0 || x >= w || y >= h {
            return true;
        }
        let m = s.grid.mat[(y * w + x) as usize];
        m != 0 && !is_gas(m) && !is_liquid(m)
    };
    // Feet at the centre of cell `cx` (x = cx*POS_ONE + POS_ONE/2 covers cx-2..=cx+2) on row boundary `fy`
    // (the body is rows fy-HITBOX_H..=fy-1). The pickup is covered when ky is in fy-HITBOX_H..=fy-1+PICKUP_REACH_BELOW.
    let half = HITBOX_W / 2;
    for cx in kx - half..=kx + half {
        for fy in ky - PICKUP_REACH_BELOW + 1..=ky + HITBOX_H {
            let free = (cx - half..=cx + half).all(|x| (fy - HITBOX_H..fy).all(|y| !solid(x, y)));
            if free {
                return true;
            }
        }
    }
    false
}

fn check(label: &str, size: u8, seeds: std::ops::RangeInclusive<u64>, cfg: fn() -> RoomConfig, bad: &mut Vec<String>) {
    for seed in seeds {
        let s = Sim::new(seed, RoomConfig { size, ..cfg() }).unwrap();
        for k in &s.pickups {
            if !reachable(&s, i32::from(k.x), i32::from(k.y)) {
                bad.push(format!("{label} size {size} seed {seed} pickup {} at ({}, {}) spell {}", k.id, k.x, k.y, k.spell));
            }
        }
    }
}

#[test]
fn every_pickup_can_be_walked_into() {
    assert_eq!(POS_ONE % 2, 0);
    let mut bad = Vec::new();
    for size in 0..=2u8 {
        check("survival", size, 1..=6, RoomConfig::survival, &mut bad);
    }
    check("caves_pvp", 2, 1..=4, RoomConfig::caves_pvp, &mut bad);
    assert!(bad.is_empty(), "{} unreachable pickups:\n{}", bad.len(), bad.join("\n"));
}

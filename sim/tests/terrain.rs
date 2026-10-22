//! R1: Solid box and Empty box terrain at every size (`plan-game-modes.md` "Config fields"). Caves'
//! walkability is proved by `gen::tests::traversable_to_every_band`; this file covers the two static fills.
use sim::config::RoomConfig;
use sim::input::{encode_cast, encode_join, encode_pos};
use sim::materials::{BEDROCK, DIRT, EMPTY, ROCK};
use sim::sim::Sim;

const BLAST: u8 = 1;
const DOWN: u16 = 16384;

fn solid_box(size: u8) -> RoomConfig {
    RoomConfig { terrain: 1, size, avatars: 1, spells: 1, ..RoomConfig::caves_pvp() }
}

fn empty_box(size: u8) -> RoomConfig {
    RoomConfig { terrain: 2, size, avatars: 0, brushes: 1, damage: 0, spells: 0, pickup_respawn: 0, ..RoomConfig::classic_sandbox() }
}

#[test]
fn solid_box_is_dirt_over_rock_with_bedrock_floor_and_walls_at_every_size() {
    for size in 0u8..=2 {
        let s = Sim::new(1, solid_box(size)).unwrap();
        let g = &s.grid;
        let (w, h) = (g.w, g.h);
        // Floor and walls are bedrock (the same convention as Empty box).
        for x in [0, w / 2, w - 1] {
            assert_eq!(g.mat[(h - 1) * w + x], BEDROCK, "size {size}: floor at x={x}");
        }
        let y = h / 2;
        assert_eq!(g.mat[y * w], BEDROCK, "size {size}: left wall");
        assert_eq!(g.mat[y * w + w - 1], BEDROCK, "size {size}: right wall");
        // Sky is open, then a Dirt layer, then Rock, down to the floor.
        let col = w / 2;
        let mut seen = (false, false, false);
        for y in 0..h - 16 {
            match g.mat[y * w + col] {
                m if m == EMPTY => seen.0 = true,
                m if m == DIRT => {
                    assert!(seen.0, "size {size}: dirt before any empty sky at y={y}");
                    seen.1 = true;
                }
                m if m == ROCK => {
                    assert!(seen.1, "size {size}: rock before any dirt at y={y}");
                    seen.2 = true;
                }
                other => panic!("size {size}: unexpected material {other} at y={y}"),
            }
        }
        assert!(seen.0 && seen.1 && seen.2, "size {size}: missing a layer: {seen:?}");
    }
}

/// Dig-sanity (not a flood-fill proof, per the brief): a player standing on the surface can Blast a path
/// from the sky down through Dirt and Rock to the bedrock floor, the same way the existing cave worlds let
/// Blast carve through Rock and Dirt (`Grid::dig`, `tuning::BLAST_DIG_RADIUS`/`BLAST_DIG_REACH`).
#[test]
fn a_player_can_dig_from_the_surface_to_the_floor_in_a_solid_box() {
    for size in 0u8..=2 {
        let mut s = Sim::new(2, solid_box(size)).unwrap();
        assert_eq!(s.push_input(&encode_join(1)), 0);
        s.step();
        let w = s.grid.w;
        let x = s.players[0].x / sim::tuning::POS_ONE;
        // Walk the player's feet down one dig-reach at a time, casting Blast straight down each time,
        // until bedrock is within one dig radius: the existing Blast dig (clears Rock/Dirt, spares Bedrock)
        // must be able to open a path the whole way, exactly like it does in Caves.
        let mut seq = 0u16;
        let start_y = s.players[0].y / sim::tuning::POS_ONE;
        let floor_y = (s.grid.h - 17) as i32; // one row above the bedrock floor band
        let mut casts = 0;
        const MAX_CASTS: u32 = 400; // enough for L's floor depth at BLAST_DIG_REACH (6 cells) per cast
        while s.players[0].y / sim::tuning::POS_ONE + 2 < floor_y && casts < MAX_CASTS {
            seq += 1;
            assert_eq!(s.push_input(&encode_cast(1, BLAST, DOWN, seq)), 0);
            // Blast's cooldown (tuning::COOLDOWN[BLAST] == 90 ticks): wait it out so each loop iteration is
            // a real cast, not a rejected one.
            for _ in 0..=sim::tuning::COOLDOWN[BLAST as usize] {
                s.step();
            }
            // No auto-gravity on the player entity in this sim; drop the avatar into the hole it just dug,
            // the same way the existing `casts_to_dig_100_rows` measurement does.
            let mut y = s.players[0].y / sim::tuning::POS_ONE;
            while y + 1 < floor_y && s.grid.mat[(y + 1) as usize * w + x as usize] == EMPTY {
                y += 1;
            }
            assert_eq!(s.push_input(&encode_pos(1, s.players[0].life, s.players[0].x, y * sim::tuning::POS_ONE, 0)), 0);
            s.step();
            casts += 1;
        }
        assert!(casts < MAX_CASTS, "size {size}: did not reach the floor in {MAX_CASTS} casts, last y={}", s.players[0].y / sim::tuning::POS_ONE);
        // The column the player dug through is now open from the start down to near the floor.
        let dug = (start_y..floor_y).filter(|&yy| s.grid.mat[yy as usize * w + x as usize] == EMPTY).count();
        assert!(dug > 0, "size {size}: no open cells after digging");
    }
}

#[test]
fn empty_box_is_a_walled_canvas_at_every_size() {
    for size in 0u8..=2 {
        let s = Sim::new(3, empty_box(size)).unwrap();
        let g = &s.grid;
        let (w, h) = (g.w, g.h);
        for x in [0, w / 2, w - 1] {
            assert_eq!(g.mat[(h - 1) * w + x], BEDROCK, "size {size}: floor at x={x}");
        }
        assert_eq!(g.mat[(h / 2) * w], BEDROCK, "size {size}: left wall");
        assert_eq!(g.mat[(h / 2) * w + w - 1], BEDROCK, "size {size}: right wall");
        assert_eq!(g.mat[h / 2 * w + w / 2], EMPTY, "size {size}: centre should be open canvas");
    }
}

#[test]
fn every_terrain_size_combination_either_generates_or_is_refused() {
    for terrain in 0u8..=2 {
        for size in 0u8..=2 {
            let cfg = RoomConfig { terrain, size, avatars: u8::from(terrain != 2), ..RoomConfig::caves_pvp() };
            assert!(Sim::new(9, cfg).is_some(), "terrain {terrain} size {size} did not generate");
        }
    }
    // Reserved/garbage terrain and size values stay refused by `decode`, never silently accepted here.
    assert!(RoomConfig::decode(&{
        let mut b = RoomConfig::classic_sandbox().encode();
        b[1] = 3;
        b
    })
    .is_none());
}

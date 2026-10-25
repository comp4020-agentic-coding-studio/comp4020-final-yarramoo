//! R4: `cfg.all_spells()` (unlimited charges) and `cfg.damage_from_players()`/`damage_from_env()` (damage
//! off) actually wired into sim rules, for the Creative preset. Before this slice both config helpers
//! existed but nothing in sim.rs/spells.rs read them (R0a's own report flagged this as deferred).
use sim::config::{RoomConfig, TERRAIN_SOLID_BOX};
use sim::input::{encode_cast, encode_join, encode_paint, encode_pos};
use sim::materials::*;
use sim::sim::Sim;
use sim::tuning::*;

const PX: i32 = POS_ONE;
const RIGHT: u16 = 0;

fn push(s: &mut Sim, b: Vec<u8>) {
    assert_eq!(s.push_input(&b), 0);
}

fn creative() -> RoomConfig {
    RoomConfig {
        terrain: TERRAIN_SOLID_BOX,
        size: 0,
        avatars: 1,
        damage: 0,
        spells: 1,
        brushes: 1,
        death: 0,
        respawn_secs: 1,
        pickup_respawn: 1,
        round: 0,
        max_players: 8,
    }
}

/// Same shape but `spells: 0, damage: 2` (pickups-only, full PvP) so a test can show the "before" case
/// side by side with Creative.
fn pvp_like() -> RoomConfig {
    RoomConfig { spells: 0, damage: 2, ..creative() }
}

fn carved(s: &mut Sim) {
    for c in 0..s.grid.chunk_count() {
        s.grid.mark_chunk(c);
    }
}

fn arena(cfg: RoomConfig, n: u32) -> Sim {
    let mut s = Sim::new(11, cfg).unwrap();
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
        let life = s.players.iter().find(|p| p.id == id).unwrap().life;
        push(&mut s, encode_pos(id, life, (1000 + 40 * (id as i32 - 1)) * PX, 190 * PX, 0));
    }
    s.step();
    s
}

#[test]
fn a_pvp_like_room_still_starts_finite_spell_charges() {
    // The "before" case this test guards: a non-Creative room's finite spells (Water etc.) start at 0,
    // unaffected by this slice.
    let s = arena(pvp_like(), 1);
    assert_eq!(s.players[0].charges[2], 0, "Water should start with no charges outside Creative");
}

#[test]
fn creative_grants_every_spell_infinite_charges_on_spawn() {
    let s = arena(creative(), 1);
    for k in 0..NUM_SPELLS {
        assert_eq!(s.players[0].charges[k], INFINITE, "spell {k} should be infinite in Creative");
    }
}

#[test]
fn creative_casting_never_depletes_charges() {
    let mut s = arena(creative(), 1);
    for seq in 0..5u16 {
        push(&mut s, encode_cast(1, 5, RIGHT, seq)); // Bomb: normally finite (PICKUP_CHARGES[5] = 5)
        for _ in 0..COOLDOWN[5] + 1 {
            s.step();
        }
    }
    assert_eq!(s.players[0].charges[5], INFINITE);
}

#[test]
fn damage_off_means_lava_and_explosions_never_hurt_a_player() {
    let mut s = arena(creative(), 1);
    let w = s.grid.w;
    // Stand the player directly in lava: in a damage-on room this costs HP every other tick.
    let (x0, y0, x1, y1) = s.players[0].hitbox_cells();
    for y in y0.max(0)..=y1.min(s.grid.h as i32 - 1) {
        for x in x0.max(0)..=x1.min(w as i32 - 1) {
            s.grid.mat[y as usize * w + x as usize] = LAVA;
        }
    }
    carved(&mut s);
    let health_before = s.players[0].health;
    for _ in 0..40 {
        s.step();
    }
    assert_eq!(s.players[0].health, health_before, "Creative must take no lava damage");

    // A Gunpowder explosion right at the player's feet would otherwise deal heavy falloff damage.
    push(&mut s, encode_paint(1, 13, x0 as i16, y1 as i16, x0 as i16, y1 as i16, 0));
    s.step();
    s.explode_at(x0, y1, 18, 0, CAUSE_GUNPOWDER);
    assert_eq!(s.players[0].health, health_before, "Creative must take no explosion damage");
    assert!(s.players[0].alive(s.tick), "Creative player must never die");
}

#[test]
fn respawn_secs_is_read_from_config_not_hardcoded_to_deathmatch_3s() {
    // A damage-on room (so apply_damage actually kills) with respawn_secs 1, not Deathmatch's 3: confirms
    // respawn_player reads the config for an arbitrary value, not a hardcoded Deathmatch-only constant
    // (R4 brief, commit 4). Deals damage directly through `apply_damage`, the shared choke point every
    // damage source goes through, so this test is about respawn timing only, not any particular hazard.
    let mut p = pvp_like();
    p.respawn_secs = 1;
    assert_eq!(p.respawn_ticks(), 60, "respawn_secs 1 should be 60 ticks, not DEATH_TICKS (180)");
    let mut s = arena(p, 1);
    let w = s.grid.w;
    let (x0, y0, x1, y1) = s.players[0].hitbox_cells();
    for y in y0.max(0)..=y1.min(s.grid.h as i32 - 1) {
        for x in x0.max(0)..=x1.min(w as i32 - 1) {
            s.grid.mat[y as usize * w + x as usize] = LAVA;
        }
    }
    carved(&mut s);
    s.players[0].health = 1; // one more lava tick (even ticks only) kills
    for _ in 0..4 {
        s.step();
        if s.players[0].health == 0 {
            break;
        }
    }
    assert_eq!(s.players[0].health, 0, "player should have died to lava");
    let death_tick = s.tick;
    assert_eq!(s.players[0].dead_until, death_tick - 1 + 60, "respawn_secs 1 should give 60 ticks, not 180");
}

#[test]
fn damage_is_still_applied_in_a_non_creative_room() {
    // The "before" case: the same lava setup in a damage-on room still hurts, so this slice did not
    // remove damage everywhere, only where the config says to.
    let mut s = arena(pvp_like(), 1);
    let w = s.grid.w;
    let (x0, y0, x1, y1) = s.players[0].hitbox_cells();
    for y in y0.max(0)..=y1.min(s.grid.h as i32 - 1) {
        for x in x0.max(0)..=x1.min(w as i32 - 1) {
            s.grid.mat[y as usize * w + x as usize] = LAVA;
        }
    }
    carved(&mut s);
    let health_before = s.players[0].health;
    for _ in 0..10 {
        s.step();
    }
    assert!(s.players[0].health < health_before, "a PvP-like room must still take lava damage");
}

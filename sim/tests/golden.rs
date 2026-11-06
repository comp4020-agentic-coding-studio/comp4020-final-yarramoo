//! Brief HF: a golden snapshot (format 15) and a scripted Survival run whose final hash is pinned.
//! A deliberate format or behaviour change regenerates both: `HF_REGEN=1 cargo test --release --test golden -- --nocapture`
//! rewrites `tests/fixtures/golden-v16.bin` and prints the new pinned hash to paste into `SCRIPTED_HASH`.
use sim::config::RoomConfig;
use sim::input::{encode_cast, encode_join, encode_pos, encode_ready};
use sim::sim::Sim;
use sim::snapshot;
use sim::tuning::*;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/golden-v16.bin");
const SCRIPTED_HASH: u64 = 7782343954484590231; // seed 1 rolls the Colossus (INT-2), so this run now exercises it

/// A seed that rolls the Deep Mage (INT-2: the boss is chosen per seed; seed 1 rolls the Colossus).
const MAGE_SEED: u64 = 2;

fn cfg_s() -> RoomConfig {
    RoomConfig { size: 0, ..RoomConfig::survival() }
}

/// Two players join and ready up, the round starts, then casts and Pos inputs on a fixed schedule; one slime killed.
fn scripted(cfg: RoomConfig, seed: u64, ticks: u32) -> Sim {
    let mut s = Sim::new(seed, cfg).unwrap();
    s.push_input(&encode_join(1));
    s.push_input(&encode_join(2));
    s.step();
    s.push_input(&encode_ready(1, 1));
    s.push_input(&encode_ready(2, 1));
    let mut seq = 0u16;
    let mut killed = false;
    for t in 0..ticks {
        if t % 40 == 20 {
            seq += 1;
            let spell = [0u8, 1, 2, 4][(seq % 4) as usize];
            s.push_input(&encode_cast(1 + (seq % 2) as u32, spell, (seq as u32 * 7919 % 65536) as u16, seq));
        }
        if t % 50 == 0 {
            for id in 1..=2u32 {
                let p = s.players.iter().find(|p| p.id == id).unwrap();
                let (x, y, life) = (p.x + (id as i32) * 160, p.y, p.life);
                s.push_input(&encode_pos(id, life, x, y, (t / 50 % 2) as u8));
            }
        }
        s.step();
        if !killed && s.round_running != 0 {
            if let Some(i) = s.enemies.iter().position(|e| e.kind != ENEMY_BOSS) {
                let hp = s.enemies[i].hp;
                s.damage_enemy(i, hp, 1);
                s.reap_enemies();
                killed = true;
            }
        }
    }
    s
}

#[test]
fn golden_snapshot_bytes_are_reproduced_and_restore_to_the_same_hash() {
    let mut s = scripted(cfg_s(), 7, 600);
    let bytes = snapshot::write(&s);
    if std::env::var("HF_REGEN").is_ok() {
        std::fs::write(GOLDEN, &bytes).unwrap();
        println!("golden written: {} bytes", bytes.len());
    }
    let golden = std::fs::read(GOLDEN).expect("fixture missing: regenerate with HF_REGEN=1");
    assert!(bytes == golden, "snapshot bytes differ from golden-v16.bin (a deliberate format change regenerates it)");
    let mut r = snapshot::restore(&golden).unwrap();
    assert_eq!(r.state_hash(), s.state_hash());
}

#[test]
fn a_scripted_survival_run_has_a_pinned_final_hash() {
    let mut s = scripted(RoomConfig::survival(), 1, 3000);
    assert_eq!(s.round_running, 1, "the round started");
    let h = s.state_hash();
    if std::env::var("HF_REGEN").is_ok() {
        println!("SCRIPTED_HASH = {h}");
    }
    assert_eq!(h, SCRIPTED_HASH, "behaviour changed (or regenerate with HF_REGEN=1)");
}

#[test]
fn the_bosss_named_state_survives_restore() {
    let mut s = Sim::new(MAGE_SEED, RoomConfig::survival()).unwrap();
    s.enemies.retain(|e| e.kind == ENEMY_BOSS);
    s.push_input(&encode_join(1));
    s.step();
    s.round_running = 1;
    let a = s.arena.unwrap();
    s.players[0].x = (a.cx + 20) * POS_ONE;
    s.players[0].y = (a.floor_y - 14) * POS_ONE;
    let bi = s.enemies.iter().position(|e| e.kind == ENEMY_BOSS).unwrap();
    s.enemies[bi].hp = (ENEMY_STATS[usize::from(ENEMY_BOSS)].hp / 2).max(1);
    for _ in 0..300 {
        s.step();
        s.players[0].health = HEALTH_MAX;
    }
    let b = s.enemies.iter().find(|e| e.kind == ENEMY_BOSS).unwrap();
    assert_eq!(b.phase, 2, "mid-fight at phase 2");
    assert!(b.summons > 0, "some summons spent");
    let mut r = snapshot::restore(&snapshot::write(&s)).unwrap();
    let rb = r.enemies.iter().find(|e| e.kind == ENEMY_BOSS).unwrap();
    assert_eq!((rb.phase, rb.summons), (b.phase, b.summons));
    for t in 0..400 {
        s.step();
        r.step();
        s.players[0].health = HEALTH_MAX;
        r.players[0].health = HEALTH_MAX;
        assert_eq!(s.state_hash(), r.state_hash(), "diverged {t} ticks after restore");
    }
}

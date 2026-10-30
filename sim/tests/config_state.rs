//! R0a: the config is part of the state. It is in the state hash and in the snapshot header, and restore refuses
//! old formats and bad headers cleanly (no panic, no overrun).
use sim::config::RoomConfig;
use sim::sim::Sim;
use sim::snapshot;

#[test]
fn different_configs_give_different_tick_zero_hashes() {
    let base = RoomConfig::classic_sandbox();
    let mut a = Sim::new(3, base).unwrap();
    let h = a.state_hash();
    assert_eq!(h, Sim::new(3, base).unwrap().state_hash());
    for (name, c) in [
        ("brushes", RoomConfig { brushes: 0, ..base }),
        ("max_players", RoomConfig { max_players: 4, ..base }),
        ("respawn_secs", RoomConfig { respawn_secs: 5, ..base }),
    ] {
        assert_ne!(h, Sim::new(3, c).unwrap().state_hash(), "{name} is not in the hash");
    }
}

#[test]
fn snapshot_carries_the_config_and_round_trips() {
    for (seed, cfg) in [(7u64, RoomConfig::classic_sandbox()), (5, RoomConfig::caves_pvp())] {
        let mut s = Sim::new(seed, cfg).unwrap();
        for _ in 0..30 {
            s.step();
        }
        let snap = snapshot::write(&s);
        assert_eq!(&snap[46..62], &cfg.encode()[..]);
        let mut r = snapshot::restore(&snap).unwrap();
        assert_eq!(r.cfg, cfg);
        assert_eq!(r.state_hash(), s.state_hash());
    }
}

#[test]
fn restore_refuses_old_and_corrupt_headers_without_panicking() {
    let s = Sim::new(7, RoomConfig::classic_sandbox()).unwrap();
    let good = snapshot::write(&s);
    assert!(snapshot::restore(&good).is_ok());
    for v in [1u16, 2, 3, 4, 6] {
        let mut b = good.clone();
        b[4..6].copy_from_slice(&v.to_le_bytes());
        assert!(snapshot::restore(&b).is_err(), "format {v} accepted");
    }
    let mut bad_cfg = good.clone();
    bad_cfg[46] = 9; // config version
    assert!(snapshot::restore(&bad_cfg).is_err());
    let mut bad_field = good.clone();
    bad_field[47] = 7; // terrain out of range
    assert!(snapshot::restore(&bad_field).is_err());
    // every truncation, including mid-header, is an Err and never a panic
    for n in 0..good.len().min(200) {
        assert!(snapshot::restore(&good[..n]).is_err(), "truncated to {n} accepted");
    }
}

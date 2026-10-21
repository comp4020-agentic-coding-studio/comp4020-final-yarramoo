//! R0a: the room config's byte layout. The same vectors are hard-coded in tests/net/room.test.ts, so the two
//! encoders cannot drift apart without one of the tests failing.
use sim::config::RoomConfig;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}

// version, terrain, size, avatars, damage, spells, brushes, death, respawn_secs, pickup_respawn, round, max_players, 4 reserved
const CLASSIC: &str = "01020000000001000000000800000000";
const CAVES: &str = "01000201020000000301000800000000";
const SURVIVAL: &str = "01000101020000010000010400000000";

#[test]
fn presets_encode_to_the_shared_vectors() {
    assert_eq!(RoomConfig::classic_sandbox().encode().to_vec(), hex(CLASSIC));
    assert_eq!(RoomConfig::caves_pvp().encode().to_vec(), hex(CAVES));
}

#[test]
fn good_vectors_round_trip() {
    for h in [CLASSIC, CAVES, SURVIVAL] {
        let b = hex(h);
        let c = RoomConfig::decode(&b).unwrap_or_else(|| panic!("{h} refused"));
        assert_eq!(c.encode().to_vec(), b);
    }
    let s = RoomConfig::decode(&hex(SURVIVAL)).unwrap();
    assert_eq!((s.death, s.round, s.max_players, s.size), (1, 1, 4, 1));
}

#[test]
fn bad_vectors_are_refused() {
    // (why, byte index, new value) applied to the classic vector; indices follow the layout comment above.
    let mutations: [(&str, usize, u8); 17] = [
        ("wrong version", 0, 2),
        ("version 0", 0, 0),
        ("terrain 3", 1, 3),
        ("size 3", 2, 3),
        ("avatars 2", 3, 2),
        ("damage 3", 4, 3),
        ("spells 2", 5, 2),
        ("brushes 2", 6, 2),
        ("death 2", 7, 2),
        ("respawn 31", 8, 31),
        ("pickup_respawn 2", 9, 2),
        ("round 2", 10, 2),
        ("round 1 needs death 1", 10, 1),
        ("max_players 1", 11, 1),
        ("max_players 9", 11, 9),
        ("reserved byte 12", 12, 1),
        ("reserved byte 15", 15, 1),
    ];
    for (why, at, val) in mutations {
        let mut b = hex(CLASSIC);
        b[at] = val;
        assert!(RoomConfig::decode(&b).is_none(), "{why} was accepted");
    }
    let good = hex(CLASSIC);
    assert!(RoomConfig::decode(&good[..15]).is_none(), "15 bytes accepted");
    let mut long = good.clone();
    long.push(0);
    assert!(RoomConfig::decode(&long).is_none(), "17 bytes accepted");
    assert!(RoomConfig::decode(&[]).is_none(), "empty accepted");
}

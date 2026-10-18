//! M5 slice 3: dropped bags. Entity bytes, drop, merge, cap, expiry, fall, pickup, view, snapshots.
use sim::entities::*;
use sim::tuning::*;

fn bag(x: u16, y: u16, c: [u16; 4], e: u32) -> Bag {
    Bag { x, y, charges: c, expires_at: e }
}

/// Entity bytes for a game world with `bags`, plus the offset where the bag count starts.
fn bytes_with(bags: &[Bag]) -> (Vec<u8>, Vec<Pickup>, usize) {
    let s = sim::sim::Sim::new(5, 1).unwrap();
    let mut pk = s.pickups.clone();
    for p in pk.iter_mut() {
        p.respawn_at = 7;
    }
    let b = encode(&[Player::new(3, 100, 200)], &pk, &[], bags);
    let at = b.len() - 4 - bags.len() * BAG_BYTES;
    (b, s.pickups, at)
}

#[test]
fn bag_is_sixteen_bytes_and_round_trips() {
    assert_eq!(BAG_BYTES, 16);
    let bags = vec![bag(10, 20, [15, 0, 0, 5], 5400), bag(2047, 1535, [0, 1, 0, 0], u32::MAX)];
    let (b, mut pk, at) = bytes_with(&bags);
    assert_eq!(&b[at..at + 4], &2u32.to_le_bytes());
    // literal layout of the first bag: x, y, four charges, expires_at, all LE
    assert_eq!(&b[at + 4..at + 20], &[10, 0, 20, 0, 15, 0, 0, 0, 0, 0, 5, 0, 0x18, 0x15, 0, 0]);
    let (players, projs, got) = decode(&b, &mut pk, 2048, 1536).unwrap();
    assert_eq!((players.len(), projs.len()), (1, 0));
    assert_eq!(got, bags);
    // and with no bags
    let (b0, mut pk0, _) = bytes_with(&[]);
    assert!(decode(&b0, &mut pk0, 2048, 1536).unwrap().2.is_empty());
}

#[test]
fn hostile_bag_bytes_fail_cleanly() {
    let good = vec![bag(10, 20, [15, 0, 0, 5], 5400)];
    let (b, pk, at) = bytes_with(&good);
    let try_decode = |b: &[u8]| decode(b, &mut pk.clone(), 2048, 1536);
    assert!(try_decode(&b).is_ok());
    // count above the cap, with a length that would match it
    let mut c = b.clone();
    c[at..at + 4].copy_from_slice(&(MAX_BAGS as u32 + 1).to_le_bytes());
    assert!(try_decode(&c).is_err());
    // huge count
    c[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(try_decode(&c).is_err());
    // count says 2, bytes hold 1
    c[at..at + 4].copy_from_slice(&2u32.to_le_bytes());
    assert!(try_decode(&c).is_err());
    // truncated, trailing byte, and cut off before the bag count
    assert!(try_decode(&b[..b.len() - 1]).is_err());
    let mut t = b.clone();
    t.push(0);
    assert!(try_decode(&t).is_err());
    assert!(try_decode(&b[..at + 2]).is_err());
    // out-of-world coordinates
    for (x, y) in [(2048u16, 5u16), (5, 1536), (u16::MAX, u16::MAX)] {
        let (b, pk, _) = bytes_with(&[bag(x, y, [1, 0, 0, 0], 0)]);
        assert!(decode(&b, &mut pk.clone(), 2048, 1536).is_err(), "{x},{y}");
    }
    // all-zero charges
    let (b, pk, _) = bytes_with(&[bag(5, 5, [0; 4], 0)]);
    assert!(decode(&b, &mut pk.clone(), 2048, 1536).is_err());
    // a full 64 bags is accepted
    let many: Vec<Bag> = (0..MAX_BAGS as u16).map(|i| bag(i, 5, [1, 0, 0, 0], 9)).collect();
    let (b, pk, _) = bytes_with(&many);
    assert_eq!(decode(&b, &mut pk.clone(), 2048, 1536).unwrap().2.len(), MAX_BAGS);
}

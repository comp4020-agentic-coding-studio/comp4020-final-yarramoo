//! D-088: restoring from the cached generated world is bit-identical to regenerating, and the cache never
//! leaks between worlds.
use sim::input::{encode_join, encode_paint, encode_pos};
use sim::sim::Sim;
use sim::snapshot;

/// A played game world: players, a move, paint that dirties chunks, then some ticks.
fn played(seed: u64) -> Vec<u8> {
    let mut s = Sim::new(seed, 1).unwrap();
    for b in [encode_join(1), encode_join(2), encode_pos(1, 0, 1000 * 4096, 230 * 4096, 1), encode_paint(1, 3, 900, 300, 1000, 330, 6)] {
        assert_eq!(s.push_input(&b), 0);
    }
    for _ in 0..40 {
        s.step();
    }
    snapshot::write(&s)
}

fn same(a: &mut Sim, b: &mut Sim) {
    assert_eq!(a.state_hash(), b.state_hash());
    assert!(a.grid.mat == b.grid.mat && a.grid.aux == b.grid.aux, "grid differs");
    assert_eq!(a.entity_bytes(), b.entity_bytes());
    assert_eq!(a.pickups, b.pickups);
    assert_eq!(a.tick, b.tick);
    assert_eq!(a.grid.pristine, b.grid.pristine);
    assert_eq!(a.grid.awake, b.grid.awake);
    assert_eq!(a.grid.active, b.grid.active);
}

#[test]
fn cached_restore_equals_regenerated_restore() {
    for seed in [1u64, 2, 3, 7, 0xdead_beef_u64] {
        let snap = played(seed);
        let donor = Sim::new(seed, 1).unwrap();
        let base = donor.base.as_ref().expect("a game world keeps its base");
        let mut fresh = snapshot::restore(&snap).unwrap();
        let mut hit = snapshot::restore_with(&snap, Some(base)).unwrap();
        same(&mut fresh, &mut hit);
        // And they keep agreeing as they play on (sleeping and the active set included).
        for _ in 0..60 {
            fresh.step();
            hit.step();
        }
        same(&mut fresh, &mut hit);
    }
}

#[test]
fn a_base_for_another_seed_or_kind_is_not_reused() {
    let snap = played(5);
    let other = Sim::new(6, 1).unwrap();
    let mut fresh = snapshot::restore(&snap).unwrap();
    let mut wrong = snapshot::restore_with(&snap, other.base.as_ref()).unwrap();
    same(&mut fresh, &mut wrong);
    assert_eq!(wrong.base.as_ref().unwrap().seed, 5, "a miss regenerates and keeps the right base");
    // A sandbox snapshot restored against a game base ignores it.
    let mut sb = Sim::new(5, 0).unwrap();
    for _ in 0..10 {
        sb.step();
    }
    let ssnap = snapshot::write(&sb);
    let mut a = snapshot::restore(&ssnap).unwrap();
    let mut b = snapshot::restore_with(&ssnap, other.base.as_ref()).unwrap();
    same(&mut a, &mut b);
    assert!(b.base.is_none(), "the sandbox keeps no base");
}

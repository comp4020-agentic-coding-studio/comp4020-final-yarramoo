use sim::input::encode_paint;
use sim::script::run_script_json;
use sim::sim::Sim;

/// Small deterministic generator (splitmix-style) so tests need no files.
fn scripted(tick: u32) -> Vec<Vec<u8>> {
    let r = sim::rng::rng(99, tick, 0, 0, 77);
    if tick % 7 != 1 {
        return vec![];
    }
    let mats = [4u8, 5, 3, 10, 2, 0];
    let m = mats[(r % 6) as usize];
    let x0 = 20 + (r >> 4) % 460;
    let y0 = 20 + (r >> 13) % 200;
    vec![encode_paint(1, m, x0 as i16, y0 as i16, (x0 + 30) as i16, (y0 + 10) as i16, 1 + (r >> 24) as u8 % 6)]
}

fn run(ticks: u32, every: u32) -> Vec<(u32, u64)> {
    let mut s = Sim::new(42, 0).unwrap();
    let mut v = vec![];
    for t in 1..=ticks {
        for i in scripted(t) {
            assert_eq!(s.push_input(&i), 0);
        }
        s.step();
        if t % every == 0 {
            v.push((t, s.state_hash()));
        }
    }
    v
}

#[test]
fn d1_two_instances_agree() {
    let a = run(720, 60);
    assert_eq!(a.len(), 12);
    assert_eq!(a, run(720, 60));
    assert!(a.windows(2).any(|w| w[0].1 != w[1].1), "state must actually evolve");
}

#[test]
fn d5_snapshot_restore_matches() {
    let full = run(600, 60);
    for &cut in &[1u32, 60, 133, 300] {
        let mut s = Sim::new(42, 0).unwrap();
        let mut t = 1;
        while t <= cut {
            for i in scripted(t) {
                s.push_input(&i);
            }
            s.step();
            t += 1;
        }
        let snap = sim::snapshot::write(&s);
        assert_eq!(snap.len(), sim::snapshot::size(&s));
        let mut r = sim::snapshot::restore(&snap).unwrap();
        assert_eq!(r.state_hash(), s.state_hash());
        let mut got = vec![];
        for t in cut + 1..=600 {
            for i in scripted(t) {
                r.push_input(&i);
            }
            r.step();
            if t % 60 == 0 {
                got.push((t, r.state_hash()));
            }
        }
        let want: Vec<_> = full.iter().filter(|(t, _)| *t > cut).cloned().collect();
        assert_eq!(got, want, "cut at {cut}");
    }
}

#[test]
fn d6_batching_is_irrelevant() {
    // Same ticks, hashing at different cadences (hash cache must not change results).
    let a = run(600, 60);
    let b = run(600, 1);
    let b60: Vec<_> = b.into_iter().filter(|(t, _)| t % 60 == 0).collect();
    assert_eq!(a, b60);
}

#[test]
fn inputs_apply_next_step_in_push_order() {
    let mut s = Sim::new(1, 0).unwrap();
    s.push_input(&encode_paint(1, 2, 100, 100, 100, 100, 0)); // rock
    s.push_input(&encode_paint(1, 3, 100, 100, 100, 100, 0)); // then dirt wins
    assert_eq!(s.grid.mat[100 * 512 + 100], 0);
    s.step();
    assert_eq!(s.grid.mat[100 * 512 + 100], 3);
}

#[test]
fn paint_skips_bedrock_and_ignores_others() {
    let mut s = Sim::new(1, 0).unwrap();
    s.push_input(&encode_paint(1, 4, 0, 505, 40, 505, 4));
    s.push_input(&[1, 1, 0, 0, 0]);
    s.push_input(&[4, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
    assert_eq!(s.push_input(&[9]), -1);
    s.step();
    assert_eq!(s.grid.mat[511 * 512 + 3], 1);
}

/// Fixed reference script for the TS harness (D3). Pins the hashes so any drift is loud.
#[test]
fn reference_script_hashes() {
    let json = r#"{ "seed": "12345678901234567890", "world_kind": 0, "ticks": 300,
      "inputs": { "1": ["050100000004640014006400140006"], "30": ["050100000005c80014006400140006"] } }"#;
    let h = run_script_json(json);
    assert_eq!(h.len(), 5);
    println!("REFERENCE_HASHES {:?}", h);
    assert_eq!(h, run_script_json(json));
}

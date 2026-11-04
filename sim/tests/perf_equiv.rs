//! Perf work (5 Nov): equivalence traces. Each scenario records, every 10 ticks, the state hash and an independent
//! xxh3 of the raw `mat` and `aux` planes (so a stale chunk-hash cache cannot hide a missed `touch`), plus the
//! snapshot bytes' hash at the end. The fixture was recorded from the unmodified code at c9552f8; an optimisation
//! that is meant to leave results unchanged must reproduce it exactly.
//! Regenerate only for a deliberate behaviour change: `PERF_REGEN=1 cargo test --release --test perf_equiv`.
use sim::config::RoomConfig;
use sim::input::{encode_cast, encode_join, encode_paint, encode_pos, encode_ready};
use sim::materials::*;
use sim::sim::Sim;
use sim::snapshot;
use xxhash_rust::xxh3::xxh3_64;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/perf-trace.txt");

type Script = Vec<(u32, Vec<u8>)>;

fn p(mat: u8, x0: i16, y0: i16, x1: i16, y1: i16, r: u8) -> Vec<u8> {
    encode_paint(1, mat, x0, y0, x1, y1, r)
}

fn planes(s: &Sim) -> u64 {
    xxh3_64(&s.grid.mat) ^ xxh3_64(&s.grid.aux).rotate_left(1)
}

/// Run a sandbox script; one trace line per 10 ticks.
fn sandbox(name: &str, sleep: bool, ticks: u32, script: &Script, out: &mut Vec<String>) {
    let mut s = Sim::new(3, RoomConfig::classic_sandbox()).unwrap();
    s.grid.sleep_enabled = sleep;
    for t in 1..=ticks {
        for (_, b) in script.iter().filter(|(tt, _)| *tt == t) {
            assert_eq!(s.push_input(b), 0);
        }
        s.step();
        if t % 10 == 0 {
            out.push(format!("{name} {t} {} {}", s.state_hash(), planes(&s)));
        }
    }
    out.push(format!("{name} snapshot {}", xxh3_64(&snapshot::write(&s))));
}

fn sand_pour() -> Script {
    let mut v: Script = vec![(1, p(ROCK, 60, 300, 200, 310, 2)), (1, p(ROCK, 250, 380, 450, 380, 3))];
    for k in 0..40u32 {
        let x = 80 + (k as i16 * 9) % 340;
        v.push((1 + k * 15, p(SAND, x, 20, x + 12, 30, 5)));
    }
    v.push((900, p(EMPTY, 100, 250, 140, 320, 6)));
    v
}

fn water_flood() -> Script {
    let mut v: Script = vec![(1, p(ROCK, 30, 450, 480, 450, 3)), (1, p(ROCK, 200, 300, 330, 300, 2)), (1, p(WOOD, 120, 380, 125, 450, 2))];
    for k in 0..30u32 {
        v.push((1 + k * 10, p(WATER, 150 + (k as i16 % 5) * 40, 40, 170 + (k as i16 % 5) * 40, 60, 8)));
    }
    v.push((600, p(OIL, 250, 100, 300, 110, 6)));
    v.push((800, p(EMPTY, 330, 440, 340, 455, 4)));
    v
}

fn lava_water() -> Script {
    vec![
        (1, p(ROCK, 100, 400, 400, 400, 3)),
        (1, p(WATER, 120, 360, 380, 390, 10)),
        (100, p(LAVA, 200, 100, 260, 120, 8)),
        (300, p(ICE, 140, 300, 160, 310, 4)),
        (300, p(SAND, 300, 250, 320, 260, 5)),
        (400, p(LAVA, 150, 200, 160, 220, 5)),
    ]
}

fn fire_wood() -> Script {
    vec![
        (1, p(WOOD, 100, 200, 300, 260, 12)),
        (1, p(COAL, 320, 230, 400, 230, 2)),
        (1, p(ROCK, 350, 150, 450, 150, 2)),
        (1, p(GAS, 360, 140, 440, 145, 3)),
        (1, p(SEED, 80, 400, 120, 400, 1)),
        (1, p(DIRT, 60, 410, 140, 420, 4)),
        (1, p(WATER, 70, 395, 75, 398, 2)),
        (5, p(OIL, 300, 190, 320, 195, 4)),
        (20, p(FIRE, 95, 230, 98, 232, 3)),
        (400, p(FIRE, 400, 225, 402, 226, 2)),
    ]
}

fn bomb() -> Script {
    vec![
        (1, p(ROCK, 50, 300, 450, 340, 10)),
        (1, p(GUNPOWDER, 60, 290, 440, 290, 3)),
        (1, p(ACID, 200, 200, 230, 210, 5)),
        (1, p(SAND, 300, 240, 340, 250, 6)),
        (100, p(FIRE, 60, 285, 62, 286, 2)),
        (500, p(GUNPOWDER, 150, 100, 350, 130, 8)),
        (510, p(LAVA, 250, 80, 255, 85, 3)),
    ]
}

/// D7-style: everything at once, run with sleeping on and off.
fn mixed() -> Script {
    let mut v = sand_pour();
    v.extend(water_flood().into_iter().map(|(t, b)| (t + 50, b)));
    v.extend(bomb().into_iter().map(|(t, b)| (t + 700, b)));
    v
}

/// A game world with players: join, ready, walk (moves the active set: frozen and woken chunks) and cast.
fn players(name: &str, cfg: RoomConfig, ticks: u32, casts: &[u8], out: &mut Vec<String>) {
    let mut s = Sim::new(5, cfg).unwrap();
    s.push_input(&encode_join(1));
    s.push_input(&encode_join(2));
    s.step();
    if cfg.round == 1 {
        s.push_input(&encode_ready(1, 1));
        s.push_input(&encode_ready(2, 1));
    }
    let mut seq = 0u16;
    for t in 1..=ticks {
        if !casts.is_empty() && t % 25 == 5 {
            seq += 1;
            let spell = casts[seq as usize % casts.len()];
            s.push_input(&encode_cast(1 + (seq % 2) as u32, spell, (seq as u32 * 7919 % 65536) as u16, seq));
        }
        if t % 30 == 0 {
            for id in 1..=2u32 {
                if let Some(pl) = s.players.iter().find(|pl| pl.id == id) {
                    let dx = if (t / 300) % 2 == 0 { 160 } else { -160 } * id as i32;
                    s.push_input(&encode_pos(id, pl.life, pl.x + dx, pl.y, (t / 300 % 2) as u8));
                }
            }
        }
        s.step();
        if t % 10 == 0 {
            out.push(format!("{name} {t} {} {}", s.state_hash(), planes(&s)));
        }
    }
    out.push(format!("{name} snapshot {}", xxh3_64(&snapshot::write(&s))));
}

fn trace() -> Vec<String> {
    let mut out = Vec::new();
    sandbox("sand_pour", true, 2000, &sand_pour(), &mut out);
    sandbox("water_flood", true, 2000, &water_flood(), &mut out);
    sandbox("lava_water", true, 2000, &lava_water(), &mut out);
    sandbox("fire_wood", true, 2000, &fire_wood(), &mut out);
    sandbox("bomb", true, 2000, &bomb(), &mut out);
    sandbox("mixed_sleep_on", true, 2000, &mixed(), &mut out);
    sandbox("mixed_sleep_off", false, 2000, &mixed(), &mut out);
    players("survival_l", RoomConfig { size: 2, ..RoomConfig::survival() }, 1500, &[], &mut out);
    let creative = RoomConfig { size: 1, ..RoomConfig::creative() };
    players("creative_m_spells", creative, 1500, &[4, 5, 2, 6, 7, 8, 10, 9, 1, 0], &mut out);
    out
}

#[test]
fn optimisations_reproduce_the_recorded_trace() {
    let t = trace();
    // Sleeping is invisible (D7): the two mixed runs agree line for line.
    let on: Vec<_> = t.iter().filter_map(|l| l.strip_prefix("mixed_sleep_on ")).collect();
    let off: Vec<_> = t.iter().filter_map(|l| l.strip_prefix("mixed_sleep_off ")).collect();
    assert_eq!(on, off, "sleeping changed the result");
    let text = t.join("\n") + "\n";
    if std::env::var("PERF_REGEN").is_ok() {
        std::fs::write(FIXTURE, &text).unwrap();
    }
    let want = std::fs::read_to_string(FIXTURE).expect("fixture missing: PERF_REGEN=1 on the unmodified code");
    for (i, (a, b)) in t.iter().zip(want.lines()).enumerate() {
        assert_eq!(a, b, "trace diverges at line {i}");
    }
    assert_eq!(t.len(), want.lines().count(), "trace length differs");
}

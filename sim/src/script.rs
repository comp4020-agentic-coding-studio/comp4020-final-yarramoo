//! Determinism-harness script runner (plan 6.11 "Input script format").
//! Hand-rolled minimal JSON reader; the sim never depends on serde.

use crate::config::{IntoRoom, RoomConfig};
use crate::sim::Sim;
use std::collections::BTreeMap;

enum J {
    Str(String),
    Num(u64),
    Arr(Vec<J>),
    Obj(BTreeMap<String, J>),
}

struct P<'a>(&'a [u8], usize);
impl P<'_> {
    fn ws(&mut self) {
        while self.1 < self.0.len() && self.0[self.1].is_ascii_whitespace() {
            self.1 += 1;
        }
    }
    fn eat(&mut self, c: u8) {
        self.ws();
        assert_eq!(self.0[self.1], c, "bad JSON at {}", self.1);
        self.1 += 1;
    }
    fn peek(&mut self) -> u8 {
        self.ws();
        self.0[self.1]
    }
    fn string(&mut self) -> String {
        self.eat(b'"');
        let s = self.1;
        while self.0[self.1] != b'"' {
            self.1 += 1;
        }
        let r = String::from_utf8(self.0[s..self.1].to_vec()).expect("utf8");
        self.1 += 1;
        r
    }
    fn val(&mut self) -> J {
        match self.peek() {
            b'"' => J::Str(self.string()),
            b'[' => {
                self.eat(b'[');
                let mut v = Vec::new();
                while self.peek() != b']' {
                    v.push(self.val());
                    if self.peek() == b',' {
                        self.eat(b',');
                    }
                }
                self.eat(b']');
                J::Arr(v)
            }
            b'{' => {
                self.eat(b'{');
                let mut m = BTreeMap::new();
                while self.peek() != b'}' {
                    let k = self.string();
                    self.eat(b':');
                    m.insert(k, self.val());
                    if self.peek() == b',' {
                        self.eat(b',');
                    }
                }
                self.eat(b'}');
                J::Obj(m)
            }
            _ => {
                let mut n = 0u64;
                while self.1 < self.0.len() && self.0[self.1].is_ascii_digit() {
                    n = n * 10 + u64::from(self.0[self.1] - b'0');
                    self.1 += 1;
                }
                J::Num(n)
            }
        }
    }
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex")).collect()
}

/// Run a script; returns `(tick, state_hash)` after every 60th tick (60, 120, ...).
/// Inputs under tick `t` are pushed before the step that produces tick `t`.
pub fn run_script_json(json: &str) -> Vec<(u32, u64)> {
    let J::Obj(o) = (P(json.as_bytes(), 0)).val() else { panic!("script must be an object") };
    let seed = match &o["seed"] {
        J::Str(s) => s.parse::<u64>().expect("seed"),
        J::Num(n) => *n,
        _ => panic!("seed"),
    };
    // "config" names a preset; the old "world_kind" 0 and 1 stay as aliases so existing scripts run unchanged.
    let cfg = match (o.get("config"), o.get("world_kind")) {
        (Some(J::Str(n)), _) => match n.as_str() {
            "classic_sandbox" => RoomConfig::classic_sandbox(),
            "caves_pvp" => RoomConfig::caves_pvp(),
            _ => panic!("unknown config {n}"),
        },
        (None, Some(J::Num(n))) => u8::try_from(*n).ok().and_then(IntoRoom::into_room).expect("world_kind"),
        _ => panic!("script needs config or world_kind"),
    };
    let ticks = match &o["ticks"] {
        J::Num(n) => *n as u32,
        _ => panic!("ticks"),
    };
    let mut by_tick: BTreeMap<u32, Vec<Vec<u8>>> = BTreeMap::new();
    if let J::Obj(m) = &o["inputs"] {
        for (k, v) in m {
            if let J::Arr(a) = v {
                let list = a.iter().map(|h| if let J::Str(s) = h { unhex(s) } else { panic!("hex") });
                by_tick.insert(k.parse().expect("tick key"), list.collect());
            }
        }
    }
    let mut sim = Sim::new(seed, cfg).expect("config");
    let mut out = Vec::new();
    for t in 1..=ticks {
        for b in by_tick.get(&t).into_iter().flatten() {
            sim.push_input(b);
        }
        sim.step();
        if t % 60 == 0 {
            out.push((t, sim.state_hash()));
        }
    }
    out
}

//! Native D3 runner: `cargo run --release --example run_script -- script.json`
//! prints `[[tick,"hexhash"],...]` with 16-digit lowercase hex, matching the TS runners.
fn main() {
    let path = std::env::args().nth(1).expect("usage: run_script <script.json>");
    let json = std::fs::read_to_string(path).expect("read script");
    let out: Vec<String> = sim::script::run_script_json(&json)
        .iter()
        .map(|(t, h)| format!("[{t},\"{h:016x}\"]"))
        .collect();
    println!("[{}]", out.join(","));
}

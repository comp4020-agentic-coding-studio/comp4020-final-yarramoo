# Decisions

One row per decision: date, what was decided, and why. `docs/plan.md` points
here wherever it changed from the original brief.

| ID | Date | Decision | Reason |
|---|---|---|---|
| D-001 | 2026-10-13 | Build the falling-sand game on a new `multa` branch from `main`, leaving `mission-control` intact. | It's a new idea; the earlier work stays available until the user picks one to submit. |
| D-002 | 2026-10-13 | Use SQLite (`node:sqlite`, WAL mode) on the `/data` volume instead of Fly Postgres. | `fly.toml` allows one machine and one volume, and a separate database app is outside the course setup. The plan already named SQLite on a volume as its fallback. |
| D-003 | 2026-10-13 | Plan for 256 MB of memory, not 512 MB. Keep only the tick log since the latest verified snapshot in memory; warn at 200 MB RSS. | 256 MB is the course-fixed machine size. Node is roughly 60–80 MB, one world about 6.3 MB, and the verify-only sim instance about the same again, so it fits with care. |
| D-004 | 2026-10-13 | Treat restore-from-snapshot plus replay as the normal start-up path, and snapshot the last player out before stamping `Leave`. | Auto-stop is on, so the machine stops whenever it idles. The marker's next-day visit always cold-starts. |
| D-005 | 2026-10-13 | Plan as an individual project. | The brief says the assessment is individual; the original plan assumed a team. |
| D-006 | 2026-10-13 | Rust for the simulation. | Rust 1.98 and the `wasm32-unknown-unknown` target are already installed; the plan's default. |
| D-007 | 2026-10-13 | Node 24 with type stripping, keeping Hono for HTTP and adding `ws` for WebSockets. | That is how the existing `Dockerfile` runs the server; no reason to change runtime. |
| D-008 | 2026-10-13 | Make the `Dockerfile` multi-stage: Rust → `sim.wasm`, Vite client build, then the `node:24-slim` runtime. | Fly builds the image remotely and CI tests that same image, so the WASM and client must build inside it. |
| D-009 | 2026-10-13 | Extend the course CI workflow with Rust and Playwright determinism jobs; keep every course step. | The course workflow gates deploys and scans secrets; it is not mine to remove. It only runs once the repo is public, so G1 is checked locally until then. |
| D-010 | 2026-10-13 | Ship structured logs and a basic dashboard with M2, by Tue 20 Oct, not at M6. | Crit 10 (Wed 21 Oct) has classmates use the URL while I read the logs. |
| D-011 | 2026-10-13 | Phone viewport: touch painting in the sandbox; the game world is spectate-only on phones. | Markers watch one session at phone width. Full avatar touch controls are too costly for the time left. |
| D-012 | 2026-10-13 | M2 runs to Tue 20 Oct (was Mon 19) and gains a first README definition of good. | Lines M2 up with the crit 10 cutoff, and the README is marked from the start. |
| D-013 | 2026-10-13 | Crit 9 (Wed 14 Oct) is not served by this branch; what to show there is the user's call. | M0 is a determinism spike with nothing playable, and the cutoff is tomorrow noon. |
| D-014 | 2026-10-13 | No format-version world resets after crit 10; write a migration instead. | From crit 10 on, classmates and markers rely on the world persisting across redeploys. |
| D-015 | 2026-10-13 | D4 (cross-architecture) uses this x86-64 Mac and CI, plus one ARM device such as a phone, once. P1 uses 4× CDP throttling on this laptop and one real phone. | There are no teammate laptops; a phone is ARM and is also a marking viewport. |
| D-016 | 2026-10-13 | Delegation follows `CLAUDE.md`, not the plan's "don't fan out subagents". | The user's harness rules take precedence over the handed-over brief. |
| D-017 | 2026-10-13 | Fix the input byte layout, `world_kind` values and the determinism script format in plan section 6.11 before M0 code exists. | The Rust sim and the TypeScript harness are built by separate delegated workers; a pinned contract stops them disagreeing. |
| D-018 | 2026-10-13 | M0 Fire touching Water is removed and nothing replaces it (no Steam yet); fire ignition of flammables is a no-op. Sand is allowed to sink into Water by swap; Fire rises into Empty only. | Steam and flammables are not in the M0 material subset; revisit when they land. |

# Ship check, 4 Nov 2026 (before the merge to `main`)

`multa` at `1e7308c`, which includes slices A, B, the active-box overlay, W (waking), C (hotbar), F (client fixes)
and J (music). CI doesn't run on `multa`, so the production stack was booted by hand.

| Check | Result |
|---|---|
| `docker build -t simulta-shipcheck .` | built |
| `docker run --memory 256m` (Fly's limit), port 8097 | `/`, `/sandbox`, `/dashboard` all 200; `server.start` logged, protocol 9 |
| `APP_URL=http://localhost:8097 pnpm check` | exit 0: typecheck, spec 2 files, 9/9 tests |
| `pnpm check:evidence` | exit 0: 17 cited commits resolve; PROCESS.md 945 words (in 900-1100) |
| `POST /api/rooms` with `mode: "creative"` | 400 `mode_retired` (D-177) |
| Two real browsers in a size-M Survival room on the image (both ready, both walked) | round started; same world on both; 33 hash checks passed, 0 failed; 0 error-level log lines |
| Container memory after the session | 102 MiB of 256 MiB |

Screenshot: `docs/art/shots/ship-check-docker-two-browsers.png`.

**Not covered here:** the capacity soak (`pnpm soak:capacity`, minutes per step) and a long session with many woken
chunks. Both are worth running against the deployed machine once it is up.

**Next:** the merge to `main` deploys to Fly. That waits for the user's go-ahead.

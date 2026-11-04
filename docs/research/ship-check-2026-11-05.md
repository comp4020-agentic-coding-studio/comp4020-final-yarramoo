# Ship check, 5 Nov 2026 (deploy readiness)

`multa` at `85fe187`, snapshot format 12, DB migration 8. Image `simulta-shipcheck:5nov`, run with `--memory 256m`,
port 8130, fresh volume, Dockerfile env (`NODE_ENV=production`), plus `SIMULTA_DEV_TELEPORT=1`.

| Check | Result |
|---|---|
| `docker build` | pass |
| Boot | pass: `server.start` protocol 9 |
| `/`, `/sandbox`, `/api/rooms` | pass: 200 |
| `/dashboard` | 200 (public aggregate view); admin routes `/dashboard/players` 403 without a token |
| `SIMULTA_DEV_TELEPORT=1` | pass: `dev.teleport_refused` (reason "production environment") logged at boot; `GET /api/rooms/:code` has no devTeleport field |
| `APP_URL=http://localhost:8130 pnpm check` | pass: typecheck, 2 files, 9/9 tests |
| Two browsers, Survival room M (`/r/K26L7C`), both ready, round started, both dug to depth 310 and 390 | pass: `round.start` active 2; hash_pass 196, hash_fail 0, resyncs 0; 0 error-level lines |
| Memory under load | 108 MiB peak of 256 MiB; 81 MiB after both left |

## Finding (not a blocker for play, needs a look)
`snapshot.rejected` (warn) fired on every periodic snapshot upload (5 in about 5 minutes, world 2, even with one
player): reason "does not decompress, or the sim refused to restore it". No hash_fail. Consequence: no snapshot is
ever accepted (`snapshots_accepted_w2` 0), so the server holds no verified snapshot for catch-up or restart in
this image. Not yet determined whether the cause is format 12 restore in the server verifier or the production image.

## Notes
- The `/dashboard` page itself is public by design; the task's "403 without a token" holds only for admin sub-routes.
- Create-room needs `config` and a browser origin; the UI path was used.
- The two sessions' camera was on the surface at round start; the lobby ready button showed "Not ready (R)" after clicking.

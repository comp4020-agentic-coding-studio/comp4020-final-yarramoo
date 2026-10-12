# Phase 1: strip report

Deleted: 15 src modules + views/cards.ts, 17 route files, 9 migrations, 8 public JS + themes/, data/ (postcodes.csv), 17 old spec files, 3 seed scripts, seed:* scripts.

Kept/changed:
- server.ts: mounts busRoutes, home, readme only.
- routes/home.ts (new): GET / "Mission Control — under construction".
- routes/readme.ts: README only (no /philosophy).
- views/layout.ts: page/csrfField/Html only; nav Home + README; no users, no scripts.
- auth.ts: CSRF only (csrfToken, csrfOk, csrfGuard, safeNext).
- bus.ts: topic regex `^mission:[A-Z0-9]{4,8}:[a-z]+$`, no auth.
- db/index.ts: mission.db, migrations runner, `tx` helper removed with skills helper (add back when needed).
- migrations/001_init.sql: `meta` placeholder table.
- Dockerfile: dropped `COPY data` and extra docs.
- jsdom/@types/jsdom kept (invariants.test.ts uses them); marked kept.

CSRF: random 32-hex `csrf` cookie (httpOnly, Lax, secure on https) set on first csrfToken() call; POSTs must submit matching `_csrf`, compared with timingSafeEqual.

Verification: `pnpm typecheck` pass; server on fresh DATA_DIR, port 8080, GET / = 200; `pnpm check` pass (2 tests); `pnpm check:evidence` pass (PROCESS.md 936 words); Dockerfile COPY sources all exist; grep for deleted-module imports: none.

Unsure: CSRF cookie is only set when a page calls csrfField; fine for now. I did not remove the `tx` helper deliberately... correction: it was removed; re-add in phase 3 if wanted.

FUTURE.md idea: none.

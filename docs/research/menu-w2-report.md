# W2 report: menu screens and routing

Start spend: $132.38 (week total at start).

## Commit 1: router (pure) + test
Red first (stub returning the title for everything): `Tests  8 failed | 3 passed (11)`.
Green after implementing: `Tests  11 passed (11)`.

## Architectural decisions for review
(filled in below)

## FUTURE.md ideas
(filled in below)

## Commit 2: title screen, top strip, players live, death log
`client/menu/live.ts` (relTime, deathLine via formatDeath, visibility-aware poller, fetchLive), `client/menu/screens.ts`,
`client/menu.ts` rewritten around a hash router, `client/menu.css` screen rules. Tests: relTime and deathLine in
`tests/net/menu-router.test.ts`. Screenshots: `docs/research/shots/menu-w2-title-{1280,390}.png`.
Fixed from screenshots: a white box round the logo was the programmatic-focus outline on the heading (suppressed for
`[data-focus]`); panel padding tightened at 390 px.

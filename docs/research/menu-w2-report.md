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

## Commit 3: types screen, settings screens (both themes), create flow
Types: three real-button cards (Survival moss, Deathmatch lava, Sandbox sand; "Desktop to play" note on coarse+narrow).
Settings: room name, S/M/L pressed-button group from `SIZE_DIMS`, steppers (respawn 1-10, max players 2-8), Public/Private
segmented control, Advanced `<details>` with every `CONFIG_FIELDS` number input kept in sync with the visible controls.
Survival is a dark descent gradient with a moss depth gauge down the left edge; Deathmatch has a lava hazard-stripe
edge. Create POSTs as before; public goes to `/r/<code>`, private to `#share/<CODE>`.
Screenshots: `menu-w2-{types,survival,deathmatch}-1280.png`. First screenshots showed the title (a stale-tab hash-only
navigation does not reload); fixed by opening about:blank first in my screenshot script. Stepper buttons enlarged
from 11 px to 22 px after the shots (too small to hit).

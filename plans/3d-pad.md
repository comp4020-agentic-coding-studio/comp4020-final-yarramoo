# 3D open pad: plan for 2026-10-13

The owner's direction: each player sits at a control panel on an open pad, in
3D, and can look up and around to see the rocket and the other players at
their panels. Low-poly. Players make gestures that the others see.

Budget: up to about $95 today; the run stops when `current_week_spend` reaches
**$135** (it was $39.38 at the start). Branch `mission-control`; nothing
merges to `main`.

## Decisions

| # | Decision | Why |
|---|---|---|
| 3D1 | The panel stays **HTML**, as an overlay (a bottom sheet on phones, a side panel on desktop). The world is a **Three.js** canvas behind it | Text and buttons on 3D surfaces are unreadable on a phone; the DOM keeps the tests, accessibility and 44 px targets |
| 3D2 | **Three.js vendored** into `public/vendor/`, loaded through an import map; no build step, no CDN at runtime | One justified dependency; the Docker image already copies `public/` |
| 3D3 | The 2D console stays as a **fallback** (no WebGL, reduced motion, or a "2D" toggle, remembered per browser) | Markers' devices vary; nothing may depend on WebGL working |
| 3D4 | Panels sit in a **ring around the rocket**, one per role in the sequence; your camera sits at your seat | The owner chose the open pad |
| 3D5 | **Low-poly from primitives**: cylinders, cones and boxes, flat shading, a small palette that reuses the status colours | Achievable in days, light on phones, coherent |

## The rule the 3D world must not break

The game works because a seat cannot see another console. So in 3D:

- **Other panels are silhouettes.** No lamps or values that mirror another
  console's state.
- **The rocket shows only public state**: countdown, hold, liftoff, ascent,
  outcome. No tank vapour on a private step. During ascent the rocket flies
  the **nominal** path whatever the anomaly, until the outcome; otherwise
  everyone could see a real anomaly and Range Safety's dilemma would be gone.
- **Gestures are coarse.** Everyone sees *that* a seat pressed something,
  never *what*: a step press and a fix press look the same. Poll calls,
  reports, holds and terminate are public anyway, so they get their own
  gestures.
- A spec test fails if a gesture or presence message carries a step id, a
  value or fault truth.

## Phases

Each phase goes through the same gate: a Sonnet worker with a brief naming its
files, review by the session, `pnpm check` green, commit, push, and a balance
check. One worker at a time.

| # | Phase | Effort | Budget |
|---|---|---|---|
| P1 | **Scene**: vendor Three.js; the pad, the low-poly rocket (varied by sequence), a ring of panels, seated crew figures, sky and light; first-person camera at your seat with drag look-around (touch and mouse); the HTML panel as an overlay; the 2D fallback and toggle; rendering paused when the tab is hidden | high | $14 |
| P2 | **Presence and gestures**: the server tracks who is connected per seat and broadcasts coarse public gestures on accepted actions, plus a throttled head direction per player; figures turn their heads, lean in to press, raise a hand for a poll, stand for a hold; callsign labels; spec tests for the redaction rule | high | $12 |
| P3 | **The moment**: the countdown on a pad clock, hold beacons, ignition, liftoff and ascent, with the camera following the climb; explosion, pad abort smoke, termination, scrub; all driven by public state and seen by everyone at once | medium | $10 |
| P4 | **Panel as an object**: the overlay styled as a physical panel or logbook per role; collapse it to look up; phone ergonomics; screenshots at 390 and 1280 px | medium | $8 |
| P5 | **Look and fix**: the session plays two-browser missions in 3D; a cold review of the 3D client for leaks of private state; fixes | session + Sonnet | $10 |

The plan comes to $54, leaving room for retries. With money left after P5, the
order is: a CPU-throttled performance pass, then a better rocket per sequence,
then a spectator camera for observers.

## Not today

README, PROCESS or reflection prose; anything on `main`; sound; textures or
imported models (primitives only); VR.

# 3D P5 review (cold read: scene, console.js, presence, look/gesture, server)

### 1. Scene never receives ascentSec, so every ascent sequence renders with the 12 s cinematic timeline — severity: medium — confidence: confirmed
- Where: public/scene/scene.js:69 (buildEffects call omits `ascentSec`); public/scene/effects.js:61-62; public/scene/boot.js:33 passes it to mountScene only.
- Failure scenario: on kestrel3 (ascentSec 60) `A` is always 0. During ascent total=12, so the rocket reaches the end of the arc at T+12 and vanishes for the remaining ~48 s. On a success outcome (`A` falsy) the cinematic branch runs: the rocket reappears on the pad and launches again for 12 s after the mission has ended. An in-ascent `explosion` gets `air=false`, so the fireball, tower lean and scorch play on the pad instead of at the arc point at outcome.atT. No private data is involved, but the public picture contradicts the public outcome.
- Evidence: grep shows `ascentSec` is read only in effects.js:61 and passed only in boot.js:33; the object literal at scene.js:69-73 has no such key.
- Suggested fix: pass `ascentSec: opts.ascentSec` in the buildEffects call. Add a test that mounts with ascentSec and checks `__scene.fx().air`.

### 2. Gesture count and timing reveal that a fault was active on a console — severity: medium — confidence: plausible
- Where: src/routes/mission.ts:177 and src/game/rooms.ts:96-98 (every accepted `step` publishes "press" to the lobby topic); src/engine/engine.ts:152-157 (a fix step is only acceptable while its fault is active and unresolved).
- Failure scenario: gestureKind hides which step, but each accepted press is broadcast with its timing. A fix step can only be accepted while a fault is active (real or glitch), so a seat that presses after finishing its scheduled steps, or presses outside its normal windows, tells everyone "a fault/caution appeared on that console". The rule says cautions and faults are private until done. Real-vs-glitch is not revealed.
- Evidence: stepUnlocked requires `active && !resolved` for fix steps; publishGesture fires on every `result.ok`. Static sequence JSON is public, so the expected press count per seat is known.
- Suggested fix: do not broadcast "press" on step acceptance. Either drop it, or fire it on a timer unrelated to acceptance (ambient fidgeting), or at least not for steps where `fixesFaults(step)` is non-empty. Keep poll, hold, resume, scrub and start gestures, which are public.

### 3. Any seat holder can start the count, and the gesture is attributed to their role — severity: low — confidence: confirmed
- Where: src/routes/mission.ts:176 (`action.type === "start" ? startMission(m, crew.id)`); src/game/rooms.ts:232 (no role check).
- Failure scenario: the UI and comment say the Flight Director starts the count, but a Propulsion holder can POST `role=propulsion&type=start` and start the mission. `publishGesture` then shows that seat's figure doing the start fist-pump. This is an authorisation gap on the gesture path and a rules gap.
- Evidence: buildAction returns `{role, type:"start"}` for any role. startMission ignores the role, and the engine action is hard-coded to `flight`.
- Suggested fix: in the route, require `role === "flight"` for `start`, and pass the verified role into publishGesture.

### 4. `roundRect` is unsupported on older Safari and Chrome, which breaks mounting and leaks the renderer — severity: low — confidence: plausible
- Where: public/scene/figures.js:211 (drawLabel, called from setLabel via setSeats and update).
- Failure scenario: on browsers without CanvasRenderingContext2D.roundRect (iOS Safari before 16, Chrome before 99), the first held seat's label draw throws inside `update()`, which `mountScene` calls synchronously. boot.js catches it and falls back to 2D, but the WebGLRenderer, its canvas and the context created earlier in mountScene are never disposed, because there is no cleanup path on a throw mid-mount. Later throws in `update` also skip `invalidate()`.
- Evidence: the `g.roundRect` call is unguarded. mountScene has no try/catch around construction after `new WebGLRenderer`.
- Suggested fix: use `g.roundRect ? g.roundRect(...) : g.rect(...)`. Wrap the mountScene body so a throw calls `renderer.dispose()` and removes the canvas.

## Areas checked and found sound
- Scene inputs: scene.js and effects.js take only the public lobby message (phase, seats, present, outcome kind and atT), the public clock and the held roles. No console view, step, value, fault or anomaly reaches the scene. boot.js forwards only mc:state, mc:gesture and mc:look. publishState builds `mc.state` from `lobby` and the clock, not `views`.
- The rocket follows one nominal arc (`pathAt(p)`) for every outcome, so the ascent does not vary with an anomaly. Lamps, beacons, scorch, tower and light level depend on phase, clock and outcome only.
- Lobby, look and gesture messages carry only role, coarse kind, `[yaw, pitch]` and presence. SSE role topics are subscribed only for held roles, and `reseat` reconnects everyone on a seat change.
- POST /m/:code/look: the seat-holder check (`holds`), `isRole`, rate limit (8 per second per crew), and the 16 KB body limit all apply, and CSRF runs as a global guard. `cleanHead` rejects NaN, Infinity, arrays and files, wraps yaw and clamps pitch. A done mission returns 409.
- Memory is bounded: at most one head per role per mission, 5 Hz coalescing per mission, `clearMission` on done, and a 10-minute idle sweep. Presence maps are keyed by callsign and cleaned on close, and the debounce timers are unref'd.
- Gesture spoofing: the role comes from the verified body, and only accepted actions publish.
- XSS: console.js builds HTML through `esc()` or `textContent`; the callsign link uses `encodeURIComponent`. Callsign labels are drawn on canvas, not as HTML. Server-side HTML goes through hono `html`.
- Lifecycle: dispose removes the visibilitychange, webglcontext and ResizeObserver handlers and the look handlers (pointer, wheel, key, blur). It also clears the blink and clock timers, disposes geometry, materials, textures and pools, removes the flash element, and cancels the rAF. boot.js handles the unmount-during-load race. The rAF stops when hidden, and `invalidate` is guarded by `document.hidden`.
- Phone performance: particle pools are fixed-size InstancedMeshes (200, 80 and 70). Canvas textures (pad clock at most 4 Hz, figure labels only on change) are not recreated per frame. The pixel ratio is capped at 1.5 on narrow screens. The loop sleeps when nothing is moving. Minor per-frame garbage (`rest()`, debug toFixed strings) is not material.

## Session response

1. `ascentSec` not passed to the effects: confirmed and fixed in scene.js. At
   T+21.5 s of a 60 s ascent the rocket is now at p = 0.36, not gone.
2. A press reveals a fault when a seat has nothing else to do: confirmed in
   principle. Fixed by noise: during the count every other figure taps its
   desk at random (about every 8 s), locally per viewer, so a real press is
   indistinguishable from fiddling.
3. Any seat could start the count: confirmed and fixed server-side (start
   requires the flight role); spec test added.
4. `roundRect` missing on older browsers: fixed with a square fallback.

## Session play-through

A real two-browser Kestrel-1 mission in 3D (kestrel: flight + ground at
1280 px; wren: propulsion at 390 px) ran to a real liftoff at T-0, seen in
both browsers at once (`3d-P5-liftoff-desktop.png`, `3d-P5-liftoff-phone.png`),
outcome SUCCESS. No JS errors.

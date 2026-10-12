# 3D extra: performance and spectators

Nothing committed. `pnpm typecheck` clean; `pnpm check` green on a fresh app at :8115 (203 tests).

## Measurements (390x844, Kestrel-3, five seats, CPU throttled via raw CDP `Emulation.setCPUThrottlingRate` from a node WebSocket script, since agent-browser has no throttle flag; headless software GL)
Frame interval, avg / p95 ms, adaptive off (`__scene.frameStats()`, `setAdaptive`, `setTier`, `memory`, `tier`, `dpr`):
- Rate 4: idle 16.7/16.8, liftoff 16.7/16.8, explosion 16.7/16.7 (no pressure).
- Rate 20: idle 24.9/33, liftoff 26.6/50, explosion 22.2/33.
- Rate 40: idle 64/167, liftoff 77/167, explosion 57/167.

## Adaptive quality
Avg of last 30 frames above 25 ms for 2 s steps down; below 20 ms for 10 s steps up (wait doubles if it bounces within 30 s). Tiers: DPR cap down 0.25 per step to 1 (1.5 gives 2 steps), then half particle rates and bursts, then fog off (there is no extra sky geometry). Rate 40 walked tiers 0 to 4 in about 12 s; unthrottled it climbed back to 0 in about 40 s. Weak spot: under JS-bound throttling the frame time barely improved (45 ms); the gain is on GPU-bound phones, which this setup cannot show.

## Leaks
Ten 3D/2D/3D toggles: geometries 38, textures 4, programs 8 after every remount; canvases 1 in 3D, 0 in 2D; flash overlay removed. No leak found.

## Sleep and hidden
Lobby idle: 0 frames in 2 s. Simulated hidden tab: 0 frames, including after a state change; resumes on show. Weak spot: in count, random fidget gestures keep frames continuous for bursts.

## Spectators
Seatless viewers orbit the pad (radius 66, height 24, about 1 min a lap); a drag holds 8 s then eases back and resumes; during ascent it frames the rocket at a slower orbit. Press-stand strip (code, sequence, phase, clock, crew with presence dots, private-consoles note, callsign link) replaces the crew panel; public lobby data only. /missions already said "Watch"; unchanged. Screenshots: `3d-extra-spectator.png`, `3d-extra-spectator-phone.png`. Weak spot: on phones the strip sits below the callsign form.

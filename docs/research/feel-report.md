# Feel report

## 1 Lava sizzle
client/hazard.ts + worker.ts gameFrame: health drop this frame while lava cell inside own hitbox (same box as sim hazard_scan), 280 ms gap, sfxSelf "sizzle" (new SfxName). Unit-tested in tests/net/hazard.test.ts (written after the code, not red-first).

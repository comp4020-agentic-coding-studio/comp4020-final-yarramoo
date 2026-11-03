// Brief F item 3: the walk cycle plays at about 9 frames/s at full walking speed, and a remote avatar's spiky
// interpolated velocity neither speeds it up nor flickers it to idle.
import { describe, expect, it } from "vitest";
import { newPoseState, updatePose } from "../../client/fx.ts";

const DT = 1000 / 60;
describe("walk animation", () => {
  it("advances about 9 frames a second at WALK speed", () => {
    const p = newPoseState(0, 0, true);
    let x = 0, now = 0;
    for (let i = 0; i < 120; i++) { x += 0.75; now += DT; updatePose(p, x, 0, DT, now, true, null); }
    const start = p.walkPhase;
    for (let i = 0; i < 60; i++) { x += 0.75; now += DT; updatePose(p, x, 0, DT, now, true, null); }
    expect(p.walkPhase - start).toBeGreaterThan(7);
    expect(p.walkPhase - start).toBeLessThan(11);
  });
  it("a one-frame stall while walking does not flicker to idle", () => {
    const p = newPoseState(0, 0, true);
    let x = 0, now = 0;
    for (let i = 0; i < 60; i++) { x += 0.75; now += DT; updatePose(p, x, 0, DT, now, true, null); }
    expect(p.pose).toBe("walk");
    now += DT; updatePose(p, x, 0, DT, now, true, null); // no movement for one frame
    expect(p.pose).toBe("walk");
    for (let i = 0; i < 60; i++) { now += DT; updatePose(p, x, 0, DT, now, true, null); }
    expect(p.pose).toBe("idle");
  });
});

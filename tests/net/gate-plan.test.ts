// The gate planner must fail safe: anything that can reach the sim, the wire format or the input path, and any path it
// does not recognise, gets the full gate (cargo, clippy, typecheck, determinism, net).
import { describe, expect, it } from "vitest";
import { plan, tierOf } from "../../scripts/gate-plan.ts";

describe("gate plan", () => {
  it("anything touching the sim, shared code or the input path is the full gate", () => {
    for (const p of ["sim/src/grid.rs", "sim/tests/golden.rs", "shared/protocol.ts", "shared/names.ts", "client/lockstep.ts", "client/worker.ts", "client/avatar.ts", "client/protocol.ts", "tests/determinism/node.test.ts", "Cargo.toml", "package.json", "pnpm-lock.yaml", "vitest.net.config.ts", "scripts/gate-plan.ts"]) {
      expect(tierOf(p), p).toBe("full");
    }
  });

  it("an unknown path is the full gate, never skipped", () => {
    for (const p of ["Dockerfile", "fly.toml", "tools/menu-vignettes.ts", "scripts/check-evidence.ts", "something/new.rs", "mise.toml"]) {
      expect(tierOf(p), p).toBe("full");
    }
  });

  it("server-only, client-only, test-only and docs-only changes skip what they cannot affect", () => {
    expect(plan(["server/world.ts", "server/verify.ts"]).steps).toEqual(["typecheck", "net"]);
    expect(plan(["client/render.ts", "client/menu.css", "client/sfx.ts"]).steps).toEqual(["typecheck", "net"]);
    expect(plan(["tests/net/slots.test.ts"]).steps).toEqual(["typecheck", "net"]);
    expect(plan(["docs/DECISIONS.md", "FUTURE.md", ".claude/skills/run-tests/SKILL.md", "tests/soak/n1.ts"]).steps).toEqual(["evidence"]);
  });

  it("the highest tier wins: one sim file among docs makes the whole change full", () => {
    const p = plan(["docs/DECISIONS.md", "client/render.ts", "sim/src/gen.rs"]);
    expect(p.tier).toBe("full");
    expect(p.steps).toEqual(["cargo", "clippy", "typecheck", "determinism", "net"]);
    expect(p.why).toEqual(["sim/src/gen.rs"]);
  });

  it("server plus client is still the net tier, never full on its own", () => {
    expect(plan(["server/main.ts", "client/room.ts"]).tier).toBe("server");
  });
});

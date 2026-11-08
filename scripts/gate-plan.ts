// Which gate steps a change needs (the `run-tests` skill, "The gate"). Reads the changed paths and prints a tier and
// the steps, so a docs-only or client-only change does not pay for cargo and the 5-minute determinism suite.
//
// Fails safe: a path it does not recognise, or anything that can reach the sim, the wire format or the input path,
// gets the FULL gate. Determinism only proves something when the sim or what feeds it changed, so it is skipped only
// when neither can have.
//
//   node scripts/gate-plan.ts [<base>]      changed vs <base> (default: multa), plus staged and unstaged edits
//   node scripts/gate-plan.ts --files a b   classify exactly these paths (tests use this)
import { execFileSync } from "node:child_process";

export type Tier = "full" | "server" | "client" | "tests" | "docs";
export const STEPS: Record<Tier, string[]> = {
  full: ["cargo", "clippy", "typecheck", "determinism", "net"],
  server: ["typecheck", "net"],
  client: ["typecheck", "net"],
  tests: ["typecheck", "net"],
  docs: ["evidence"],
};
const RANK: Tier[] = ["docs", "tests", "client", "server", "full"];

/**
 * Paths that can change what the sim computes or what reaches it, so they always need the full gate:
 * the sim itself, code both sides import, the client's input path (lockstep and the worker feed inputs and hashes),
 * the wasm build, and the gate's own configuration.
 */
const FULL: RegExp[] = [
  /^sim\//,
  /^shared\//,
  /^client\/lockstep\.ts$/,
  /^client\/worker\.ts$/,
  /^client\/avatar\.ts$/, // the local controller produces Pos inputs
  /^client\/protocol\.ts$/,
  /^tests\/determinism\//,
  /^Cargo\.(toml|lock)$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^vitest\..*config\.ts$/,
  /^tsconfig\.json$/,
  /^scripts\/gate-plan\.ts$/, // changing the planner is itself a full-gate change
];

/** Classify one path; anything not listed is `full`. */
export function tierOf(path: string): Tier {
  if (FULL.some((r) => r.test(path))) return "full";
  if (/^server\//.test(path)) return "server";
  if (/^client\//.test(path)) return "client";
  if (/^tests\/net\//.test(path)) return "tests";
  if (/^spec\//.test(path)) return "tests";
  if (/^tests\/soak\//.test(path)) return "docs"; // benches: run by hand, never part of the gate
  if (/\.md$/.test(path) || /^docs\//.test(path) || /^\.claude\//.test(path)) return "docs";
  if (/^(FUTURE|PROCESS|README|CLAUDE)\.md$/.test(path)) return "docs";
  return "full"; // unknown: fail safe
}

/** The highest tier among the changed paths; no paths at all is `docs`. */
export function plan(paths: readonly string[]): { tier: Tier; steps: string[]; why: string[] } {
  let tier: Tier = "docs";
  const why: string[] = [];
  for (const p of paths) {
    const t = tierOf(p);
    if (RANK.indexOf(t) > RANK.indexOf(tier)) tier = t;
    if (t === "full") why.push(p);
  }
  return { tier, steps: STEPS[tier], why: tier === "full" ? why.slice(0, 8) : [] };
}

function changed(base: string): string[] {
  const run = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
  // Committed since base, unstaged, staged, and untracked new files (a brand-new sim file must count).
  const set = new Set([
    ...run(["diff", "--name-only", `${base}...HEAD`]),
    ...run(["diff", "--name-only", "HEAD"]),
    ...run(["diff", "--name-only", "--cached"]),
    ...run(["ls-files", "--others", "--exclude-standard"]),
  ]);
  return [...set].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const paths = args[0] === "--files" ? args.slice(1) : changed(args[0] ?? "multa");
  const p = plan(paths);
  console.log(`tier: ${p.tier}`);
  console.log(`steps: ${p.steps.join(" ")}`);
  console.log(`changed: ${paths.length} path(s)`);
  if (p.why.length) console.log(`full because: ${p.why.join(", ")}`);
}

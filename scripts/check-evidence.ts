#!/usr/bin/env node
// Checks what would otherwise be silently wrong in the process evidence:
// CLAUDE.md missing, no crit reflection under a name the cutoff sweep reads,
// PROCESS.md still carrying its template comment, or a cited commit that
// doesn't exist in this repo (a citation is a markdown link whose text is an
// abbreviated SHA or a sha...sha range). How the account is told, and how much
// it cites, is the marker's to judge.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// each crit's cutoff reads its own; any one passes here
const REFLECTIONS = ["crit-8.md", "crit-9.md", "crit-10.md"];

let failed = false;
const fail = (msg: string): void => {
  console.error(`✗ ${msg}`);
  failed = true;
};

if (!existsSync("CLAUDE.md")) {
  fail("no CLAUDE.md in the repo root — the harness is part of what's marked");
}

const reflections = existsSync("reflections") ? readdirSync("reflections") : [];
for (const f of reflections) {
  if (f.endsWith(".md") && f !== "README.md" && !REFLECTIONS.includes(f)) {
    console.warn(`! reflections/${f} isn't a name the cutoff sweep reads`);
  }
}
const found = REFLECTIONS.filter((name) => reflections.includes(name));
if (found.length > 0) {
  console.log(`✓ reflections/${found.join(", reflections/")}`);
} else {
  fail(`no reflection — each crit's cutoff reads its own: ${REFLECTIONS.join(", ")}`);
}

if (!existsSync("PROCESS.md")) {
  fail("no PROCESS.md in the repo root");
  process.exit(1);
}

const src = readFileSync("PROCESS.md", "utf8");

if (src.includes("TEMPLATE:")) {
  fail("PROCESS.md still contains the template comment — replace it with your own account");
}

const shas = new Set<string>();
for (const match of src.matchAll(/\[`?([0-9a-f]{7,40}(?:\.\.\.[0-9a-f]{7,40})?)`?\]\(/g)) {
  for (const sha of match[1].split("...")) shas.add(sha);
}

for (const sha of shas) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
  } catch {
    fail(`cited commit ${sha} doesn't exist in this repo`);
  }
}

// The brief asks for 900-1100 words and marks down a bad overshoot. Overshoot
// is how this file goes wrong: each batch of work appends a paragraph and
// nothing trims, so the ceiling fails. The floor only warns, because CI runs
// this before every deploy and PROCESS.md is still growing through crits 8-10.
const WORDS: [number, number] = [900, 1100];
const prose = src
  .replace(/<!--[\s\S]*?-->/g, " ") // HTML comments
  .replace(/```[\s\S]*?```/g, " ") // fenced code
  .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links: keep the text, drop the URL
  .replace(/^[\s>*+-]+/gm, " ") // list bullets, blockquote marks
  .replace(/[#*_`|]/g, " ")
  .replace(/\s[—–-]+\s/g, " "); // standalone dashes aren't words
const words = prose.split(/\s+/).filter(Boolean).length;
if (words > WORDS[1]) {
  fail(
    `PROCESS.md is ${words} words — the brief asks for ${WORDS[0]}-${WORDS[1]}. ` +
      "Condense; don't drop a disclosure, since the disclosure is the point.",
  );
} else if (words < WORDS[0]) {
  console.warn(`! PROCESS.md is ${words} words — the final submission needs ${WORDS[0]}-${WORDS[1]}`);
}

if (failed) process.exit(1);
console.log(
  shas.size > 0
    ? `✓ PROCESS.md: ${shas.size} cited commit(s), all resolve`
    : "✓ PROCESS.md: no commit links to check",
);
if (words >= WORDS[0]) console.log(`✓ PROCESS.md: ${words} words, within ${WORDS[0]}-${WORDS[1]}`);

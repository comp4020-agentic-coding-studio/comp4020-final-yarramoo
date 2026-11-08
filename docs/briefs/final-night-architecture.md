# Brief: refresh ARCHITECTURE.md after the 8-9 Nov merges (final night)

**Model:** Sonnet. **Cap:** $4, about 40 tool calls. **Never dispatch** other agents. Work in the main checkout
`/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo` on branch `multa`; **do not commit**, the lead commits.

## Files you may touch
- `ARCHITECTURE.md` (root; keep it there)
- `docs/architecture/doc-index.md` (only if it lists research notes or decisions that need the rows below)

Nothing else. Don't touch `README.md`, `PROCESS.md`, `docs/DECISIONS.md` or code. **A gate may be running in this
checkout**: you only edit the two Markdown files above, which the gate does not read, so that's safe. Do not run
`cargo`, `pnpm test*`, `pnpm build*` or anything that rebuilds the wasm. `rm` only on a literal absolute path, never a
variable or glob (you should not need `rm` at all).

## What's stale (verify each in the source before writing it)
1. Protocol version is **10**, not 9 (`shared/protocol.ts:19`, chat added `C_CHAT`/`S_CHAT`, D-229). Section 2.1's Shared row.
2. **Warm verify is merged (D-228)**: at the Fly quota 1 room now holds (was 0) and verify rejections went from 8-25
   per run to 0; two rooms still don't hold (CPU-bound). Update the Capacity table row ("Finding, not fixed") and the
   "Capacity at the Fly quota" bullet in section 6 (it says warm verify is briefed and not merged). Read D-228 in
   `docs/DECISIONS.md` for the facts; cite D-228 and `docs/research/capacity-2026-11-07.md` / whatever D-228 cites.
3. **D-219 closed by D-231**: the Survival claims test's flake was its own wall-clock pacing. Section 6's bullet and
   section 5.7's mention (~line 336) say the fix is open: say it's closed (D-231).
4. **D-217 closed by D-232**: the eight cell-rule salts were renumbered 260-267 -> 291-298. Section 3 invariant 6 row
   (~line 136), section 4 RNG row (~line 162), section 6 bullet: update to closed (D-232).
5. Add, where they fit (section 4 tables, client/server rows): **chat** (D-229: server-relayed, never a sim input,
   invariant 1), **sound by cause** (D-230: client-only, display-only, invariant 9), **lava levelling under both scan
   directions** (D-233, engineering-decisions entry 39's addendum), **backdrop shaft rim** (D-234, entry 45's addendum).
   Read those rows in `docs/DECISIONS.md` first; one table row each, short.
6. Section 5 (harness): mention `docs/skills.md` if it exists (check) and the tiered-gate rule added in commit
   `a2c0ea8` (`git show a2c0ea8 --stat` and read the diff of `.claude/skills/run-tests/SKILL.md`): a worker's gate counts
   when the merged tree equals what it gated (fork = multa head, staged merge = branch). Section 5.3 is "The tiered
   gate": one or two sentences there.
7. Anything else you notice that the D-rows from D-226 to D-234 contradict in ARCHITECTURE.md: fix it if it's a fact,
   list it in your report if it's a judgement.

## Rules
- Match the file's existing voice: plain, short sentences, no em-dash chains, cite D-rows and entries as the file does.
  Do not grow the file much: replace stale text, don't append paragraphs.
- **Link-check** every relative link and anchor you add or touch: the file must exist (`ls`), and an anchor
  `#NN-slug` must match a heading in `docs/engineering-decisions.md` (GitHub slug rules: lowercase, spaces to `-`,
  punctuation dropped). Every D-row you cite must exist in `docs/DECISIONS.md`.
- Write your findings to `docs/research/final-night-architecture-notes.md` as you go (a short list: what you changed,
  line refs, what you verified, anything you left), so a run that dies leaves something.

## Report back
What you changed (by section), what you verified and how, links checked, anything left, and a section
"Architectural decisions for review" (likely: none, it's docs).

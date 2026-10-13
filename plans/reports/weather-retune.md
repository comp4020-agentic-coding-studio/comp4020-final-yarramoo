# Weather retune: start inside nominal

Old: ceiling 3600, lightning 21 (both out of nominal), fronts every 40 s.

New (both): ceiling 7000, lightning 40, shear 10; `everySec: 25`.

| value | kestrel2 drift/s | kestrel3 drift/s |
|---|---|---|
| ceiling | [-48, 70] (was [-10, 30]) | [-35, 55] (was [-5, 30]) |
| lightning | [-0.55, 0.8] (was [-0.15, 0.35]) | [-0.4, 0.75] (was [-0.1, 0.4]) |
| shear | [-0.15, 0.15] | [-0.13, 0.13] |

Measured over 400 seeds (hold-and-resume bot):
- Kestrel-2: amber at a poll 21.5%; among wins that were amber, median total hold 45 s (p75 89 s); win rate 84.5% (test: >= 80%).
- Kestrel-3: amber at a poll 10.5% (below the 25-40% aim); median hold 132 s; bot without a terminating range officer wins 65%. Wider drift failed the 90% range test.

Caveat: raising amber rates further drops win rates under the thresholds, which I did not weaken.

Tests: new "weather starts calm" test; front-timing numbers updated. Engine, typecheck and `pnpm check` green.

## Session review

Accepted. The bug (Weather amber from the first second, unchangeable for 40 s)
is fixed, with a regression test over every shipped sequence. The amber-rate
target was missed rather than weakening win-rate thresholds, which is the
right trade. Open for the owner: Kestrel-3's median weather hold (132 s)
nearly spends its 150 s hold budget.

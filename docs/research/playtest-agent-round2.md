# Playtest (agent) round 2, 5 Nov: did round 1's findings get fixed?

Build: /tmp/wt-pt2 (multa), size S room (SUKD55) and size M room (FET9V9), two sessions (Alice, Bob), 1280x800, one phone check at 390x844. Could not judge: audio, 60 Hz feel, the music icon's look beyond a glance.

| Round-1 finding | Verdict | Evidence |
|---|---|---|
| Menu: Survival said "NO DAMAGE" | fixed | Menu card now green "CO-OP" badge (pt2-menu.png) |
| Music icon black on dark header | fixed | Menu/room header show a legible light note icon, on desktop and phone |
| Lobby "Waiting for 1" | fixed | "0 of 1 ready", then "1 of 2 ready" in S and M (pt2-phone-lobby.png) |
| Party fell had one button | fixed | S and M: "The party reached 429 m / 514 m down" + Spectate / Find another room / Start a new room (pt2-partyfell-S/M.png) |
| Dead player sees no cause/depth | fixed | Depth on overlay; death line "Killed by the Deep Mage. Spectating" (M), DOM check |
| Cause text not seen for imps | not verified | Both imp runs ended with the party dead before I read the line; only boss cause text captured |
| Dimmed empty spell slots | fixed | Zero-charge slots dim vs Push/Blast/Dig (all screenshots) |
| Players overlapping, labels clipped | mostly fixed | S: Bob label sits above Bob, Alice's offset (pt2-hover-S.png). Spawn proximity unchanged but readable |
| Phone header overflowed in room | fixed | 390 px room header fits Share, sound, music, README in one row (pt2-phone-lobby.png) |
| Sandbox palette scrolled off right | fixed | Desktop: all 18 materials wrap to two rows; phone: wraps to 5 rows (pt2-phone-sandbox.png) |
| Phone sandbox | regressed (minor) | On 390x844 the wrapped palette's last row (Erase) and the "Brush"/"Fill empty only" row sit under the hint toast; Erase greyed out by it |
| Phone room: canvas offset, hard grey rules (P12) | not fixed / unclear | Lobby on phone: world strip is mid-screen, blank dark bands above and below, hotbar clipped at the bottom by the hint toast |
| Hover names (new) | fixed, works | ~600 ms rest: pickup "Acid Flask x8", player "Bob", material "Rock", boss "Deep Mage 800/800", own "Alice" with health bar. Slime hover at (941,357) showed nothing (cursor likely a few cells off, slime tiny; not confirmed) |
| Hover tooltip duplicates player name | minor | Hovering Bob shows "Bob" tooltip right under the existing "Bob" label (pt2-hover-S.png) |
| Seed-based skies, above ground only | fixed | S room: starry night; M room: starry night; phone S room: daytime blue with sun. Caves dark in all |
| Rooms deleted 2 min after last member leaves | fixed | Log: room.deleted reason empty for S room (left 08:30, deleted 08:33:22) and M room (left 08:37:50, deleted 08:41:02); both gone from /api/rooms (lag is the sweep interval, about 3 min not 2) |
| Name prompt after Create (R1 P7) | not fixed | Still asks for a name only after pressing Create (Create button disables, then prompt) |
| Hotbar "0" charges unexplained (R1 P6) | partly | Dimming helps; still no hint how to get charges |
| Dev teleport next to enemy kills fast (R1 P1) | unchanged | Party dead within 20 s in S and M (expected with teleport) |
| Console | clean | Only "render path: WebGL2 on OffscreenCanvas in worker" logs |

Regressions found: none severe. Phone sandbox toast overlap and phone room layout are the two to look at.
Size S vs M: no S-only bug seen; S lobby/desc/death/hover all behaved like M.
Screenshots: docs/art/shots/pt2-*.png

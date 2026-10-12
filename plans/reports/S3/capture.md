# S3 screenshot capture

Mission code: 5CC5V. Players: kestrel (A, flight and ground seats), wren (B, propulsion seat). Mission started, then scrubbed. Server on port 8103, fresh DATA_DIR.

| Page | scrollWidth at 390 | Small tap targets at 390 (under 44px either side) | JS errors | Screenshots |
|---|---|---|---|---|
| home | 390 | Mission Control 169x38; Home 43x43; Missions 63x43; Agency 54x43; README 64x43 | none reported | home-390.png, home-1280.png |
| lobby | 390 | Mission Control 169x38; Home 43x43; Missions 63x43; Agency 54x43; README 64x43 | none reported | lobby-390.png, lobby-1280.png |
| console-flight | 390 | Mission Control 169x38; Home 43x43; Missions 63x43; Agency 54x43; README 64x43 | none reported | console-flight-390.png, console-flight-1280.png |
| console-ground (tab, 390 only) | 390 | Mission Control 169x38; Home 43x43; Missions 63x43; Agency 54x43; README 64x43 | none reported | console-ground-390.png |
| console-propulsion (B) | 390 | Mission Control 169x38; Home 43x43; Missions 63x43; Agency 54x43; README 64x43 | none reported | console-propulsion-390.png, console-propulsion-1280.png |
| outcome (after scrub) | 390 | Mission Control 169x38; Home 43x43; Missions 63x43; Agency 54x43; README 64x43 | none reported | outcome-390.png, outcome-1280.png |
| missions | 390 | Mission Control 169x38; Home 43x43; Missions 63x43; Agency 54x43; README 64x43; 5CC5V 60x19; Replay 49x18 | none reported | missions-390.png, missions-1280.png |
| replay | 390 | Mission Control 169x38; Home 43x43; Missions 63x43; Agency 54x43; README 64x43; "← All missions" 104x18 | none reported | replay-390.png, replay-1280.png |
| agency | 390 | Mission Control 169x38; Home 43x43; Missions 63x43; Agency 54x43; README 64x43; 5CC5V 54x16 | none reported | agency-390.png, agency-1280.png |
| readme | 390 | Mission Control 169x38; Home 43x43; Missions 63x43; Agency 54x43; README 64x43; Hackaday.io 88x18; CollabFinder 91x18; Canberra Rocketry Gr 185x18; NSW Rocketry Associa 193x18; eSafety Commissioner 162x18 | none reported | readme-390.png, readme-1280.png |

Notes:
- All 390 pages have scrollWidth 390, so no horizontal overflow.
- "none reported" means the `errors` command printed nothing for that page (it was cleared before each page). It is not a separate check of the browser console.
- Every screenshot captured successfully. Four early files (missions-, replay-, agency-, readme-) were wrong because a zsh loop dropped the viewport arguments; they were deleted and recaptured at 390 and 1280.
- Screenshots are plain `screenshot --full`. The 390 and 1280 captures use separate viewport settings.

## Session review and fixes

No page scrolls sideways at 390 px and no JS errors. Fixed after looking at
the phone screenshots:
- The console head (clock, phase, hold window) now sticks to the top while
  scrolling to steps and polls (`sticky-390.png`).
- Role tabs no longer show in the lobby before the count starts.
- Nav links are 44 px tall; links inside tables get padding as tap targets.
Left alone: the README's inline links (text links inside sentences).

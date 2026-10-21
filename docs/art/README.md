# Concept art

Generated with `flux-schnell` (5 images) as concept art only. The in-game sprites are hand-reduced grids in `client/fx.ts`, not generated assets (D-128). Common prompt suffix: `, 16-bit pixel art, side view, limited palette, dark cave background, crisp pixels, no text, no UI`. Images shrunk with `sips -Z 384`.

| Image | Prompt subject | Used for |
|---|---|---|
| `concept/caster.png` | tiny robed wizard sheet, idle/walking/casting, pointed hood | Used: the pointed, bent hood tip and the belt as a darker band. Ignored: the beard and the 3:1 height (too tall for 7x10). Garbled title text, discarded. |
| `concept/firebolt.png` | fire bolt, bright core, ember trail | Used: white-yellow core, orange body, a few detached sparks behind. |
| `concept/bomb.png` | round black bomb, lit fuse | Used: dark body with an offset highlight, a yellow-white fuse flare. Off-style: the cave background is cluttered. |
| `concept/explosion.png` | burst with core, ring, debris, smoke | Used: white core, orange-yellow ring, red embers, grey-blue smoke puffs that rise. |
| `concept/pouch.png` | leather pouch with cord and glint | Used: round belly, narrow neck, a cord tail, a gold sparkle. The loot inside is too fine to reduce. |

## Menu icons (21 Oct)

Generated with `recraft-v3` for the main menu's mode cards (plan `docs/plan-game-modes.md`, M3). Shrunk to 256 px PNG with `sips`. Common prompt suffix: `, 16-bit pixel art game icon, one bold simple silhouette filling the frame, chunky crisp pixels, limited palette of sand yellow, ember orange and deep cave blue, plain dark navy background, no text, no border, readable at 64 pixels`.

| Image | Prompt subject | Notes |
|---|---|---|
| `menu/creative.png` | a sandcastle with a paintbrush leaning on it | The brush came out as a broom; reads fine at size |
| `menu/creative-alt.png` | a hand with a paintbrush pouring sand onto a tiny castle | First trial; too detailed for 64 px |
| `menu/deathmatch.png` | two crossed staffs with fire orbs | Strongest of the set |
| `menu/survival.png` | a lone hooded figure on a rock pillar, one flame | Darker than the others; may need a lighter background to sit on the card |
| `menu/sandbox.png` | an hourglass with sand, water and a flame | Good |
| `menu/logo.png` | a falling sand stream forming a pile, a tiny wizard on top casting a spark | Second attempt; shows sand and spells together. The first (a dune with a cave) read as a pyramid and was replaced |
| `menu/logo-alt.png` | caves in cross-section, sand pouring down a shaft | Reads as a mine entrance; kept as an option |

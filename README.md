# Simulta

A shared falling-sand world in the browser. Everyone in it sees the same sand,
water, fire, lava and plants, live, and what you leave behind stays for the
next person.

## What it is

Simulta is a multiplayer Noita and Sandspiel: a cellular-automata world of
solid, liquid and gas particles. Players pick a
co-op Survival descent to a boss, a Deathmatch, or a creative sandbox, choose
how the world is generated, and can keep a sandbox of their own that persists
until they delete it (if they want to test a server restart for some reason). 

## What good means here

Noita and Sandspiel are single-player cellular automata games that are the inspiration for this project. I
wanted to know whether an AI harness could build a multiplayer version, which
is a hard technical problem. So good here is definitely technical, but the game also has to be fun to play:

- **One world, not copies.** Every player in the same game world sees the same cells. A lava flow in
  one browser burns the same wood in every other, and clients that disagree are caught and fixed. 
- **Live.** A change reaches everyone in the room within a few frames, and one
  player's slow connection does not slow the room down. Players with high ping are notified however, as the game is hard to play on a poor network. 
- **It persists.** A world survives a server restart and comes back at the same
  tick. Players are given a single sandbox that persists just for them. Survival and deathmatch gamemodes are transient - worlds deleted soon after all players have left. 
- **Interesting to play.** Enough materials, spells and enemies that the
  simulation is worth sharing.

Somewhat of a mix between enforced and judged is the 'correctness' of the particle simulation, 
balanced with enjoying some of the mistakes that fall out. For example, liquids were not 
correctly simulated for a long time due to nuances of chunk update ordering. This had to be corrected for 
liquids to move in an intuitive way, not blocked by invisible walls. 

To contrast, rain when added seemed to fall upwards. A missing '-' sign somewhere probably (the 
agent can only see screenshots when testing so some of these movement errors are harder to catch).
But it looked cool so I left it. Additionally, snow can sometimes leave ice, which is a solid particle the 
player cannot walk through. Gravity on small solid chunks is a feature, but only when the player digs it 
free. So these small ice particles float in the world and enemies were added that leave them behind like 
a trail. These can quickly turn into a trap if the player is not careful, which is a fun twist! 

## What I looked at

- Noita (Nolla Games), whose every pixel is simulated, and the [Noita wiki on
  world generation](https://noita.wiki.gg/wiki/World_generation): what a
  falling-sand world can feel like, and how its caves are built.
- Max Bittker's [Sandspiel](https://sandspiel.club): proof that a browser can
  run a full cellular simulation, shared between players.

## What is enforced and what is judged

Enforced by checks that fail when the claim breaks:

- **One world:** the same inputs in Node, Chromium, Firefox, WebKit and native
  Rust must give bit-identical hashes, and a deliberately broken build must be
  caught (`pnpm test:determinism`).
- **Live and shared:** two clients join the running app, one paints, and both
  must agree on the world's hash (`spec/game.test.ts`).
- **Persistence:** a world comes back after a restart from its snapshot and
  input log (`tests/net/persistence.test.ts`).
- **The simulation's rules** (integers only, no host clocks or randomness) are
  in `CLAUDE.md`, enforced by clippy.

Judged by playing it: whether the materials feel right and the game is fun. I
playtested every major build myself, and agents played scripted rounds and took screenshots.

## What I chose not to build

- **A server-side simulation:** too little CPU and memory, and players'
  browsers are free compute.
- **Accounts and passwords:** a player is a name and a token kept in the
  browser.

## Getting in

Open [comp4020-final-yarramoo.fly.dev](https://comp4020-final-yarramoo.fly.dev/),
choose a name, then **New game** or **Join game**, or **My world** for your own
sandbox. Move with WASD or the arrow keys, aim and cast with the mouse, pick
spells with the number keys, and press `/` to chat. Phones play with on-screen
controls. The architecture and the decisions behind it are in
[ARCHITECTURE.md](ARCHITECTURE.md).

# Simulta

A shared falling-sand world in the browser.

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
liquids to move in an intuitive way, not blocked by invisible walls. However, rain was added upside-down, 
and placing snow creates floating ice particles - which become a genuine barrier and potential trap 
for the survival player. Both of these looked cool so they were left. 

## What I looked at

- Noita (Nolla Games), and the [Noita wiki on world
  generation](https://noita.wiki.gg/wiki/World_generation): how its caves are built.
- Max Bittker's [Sandspiel](https://sandspiel.club): a full cellular simulation in a browser.

## What is enforced and what is judged

Enforced by checks that fail when the claim breaks:

- **One world:** the same inputs in Node, three browsers and native Rust must
  give identical hashes (`pnpm test:determinism`).
- **Live and shared:** two clients must agree after a paint (`spec/game.test.ts`).
- **Persistence:** a world survives a restart (`tests/net/persistence.test.ts`).
- **The simulation's rules** (integers only, no host clocks) are in `CLAUDE.md`.

Judged by playing it: whether the materials feel right and the game is fun. I
playtested every major build myself, and agents played scripted rounds and took screenshots.

## What I chose not to build

- **A server-side simulation:** too little CPU and memory.
- **Accounts and passwords:** a player is a name and a browser token.

## Getting in

Open [comp4020-final-yarramoo.fly.dev](https://comp4020-final-yarramoo.fly.dev/),
choose a name, then **New game** or **Join game**, or **My world** for your own
sandbox. Move with WASD or the arrow keys, aim and cast with the mouse, pick
spells with the number keys, and press `/` to chat. Phones play with on-screen
controls. To see persistence, open **My world**, paint, copy its link and come back to that link later, from any
browser: the world stays until its owner deletes it. Your identity is a token in this browser, so another browser
can paint there but not delete it. Architecture and decisions: [ARCHITECTURE.md](ARCHITECTURE.md).

# Sandbox

A shared falling-sand world in the browser. Everyone in it sees the same sand,
water, fire, lava and plants, live, and what you leave behind stays for the
next person.

## What it is

One world of falling sand, in the style of Noita and Sandspiel. Pick a
material and paint: sand piles, water finds its level, fire spreads to wood
and burns out as smoke, gunpowder chains into explosions, and seeds grow into
flowers. Open it in two browsers and a stroke in one appears in the other
within about a second. Close the tab and come back tomorrow, and the world is
still there, changed by whoever came in between.

## What good means here

Good means a shared world that has enough mechanics to be interesting, and 
incentivises interaction between players. It should also technically be 
able to support simulating and rendering the shared world and real-time 
player interactions, within the compute constraints of the server. 

## What I read and looked at

- Noita (Nolla Games), whose every pixel is simulated, and the [Noita
  wiki on world
  generation](https://noita.wiki.gg/wiki/World_generation): what a falling-sand
  world can feel like, and how its caves are built.
- Max Bittker's [Sandspiel](https://sandspiel.club), a falling-sand game in the
  browser whose players share what they make: proof that a browser can run a
  full cellular simulation, and a model of people building on each other's
  worlds.
- Sean Barrett's [herringbone Wang
  tiles](https://nothings.org/gamedev/herringbone/herringbone_tiles.html), the
  technique behind Noita's caves, which I compared against noise and tunnelling
  for my own generator.

## What is enforced and what is judged

Enforced by checks that fail when the claim breaks:

- **Identical worlds:** the same inputs in Node, Chromium, Firefox, WebKit and
  native Rust must give bit-identical hashes. A deliberately broken build must
  be caught, which proves the check can fail.
- **Real time and shared state:** two clients join the running app, one paints,
  and both must agree on the world's hash once it lands (`spec/`).
- **Persistence:** the world survives a server restart and comes back at the
  same tick from its saved snapshot and input log.

Judged, by watching people use it: whether the materials feel right, and
whether a shared world makes people play together or just alongside each
other.

## What I chose not to build

- **A server-side simulation.** The course machine has one shared CPU and
  256 MB, too little to run the world for everyone; players' browsers are free
  compute.
- **Accounts and chat.** Painting needs no sign-in, and the shared world is
  the conversation: you answer someone by building on what they left.
- **A reset button for players.** A world that anyone can wipe isn't one that
  lasts. Only the admin can reset a world, behind a token.

## Status

Live at [comp4020-final-yarramoo.fly.dev](https://comp4020-final-yarramoo.fly.dev/).
The front page is a generated cave world with players: walk, levitate and dig
down through the caves, pick up spells (Push, Blast, Water, Rose, Fire bolt and
Bomb), and fight. Death drops your spells as a bag anyone can take, and
achievements are awarded for what you do. The shared painting sandbox is at
[/sandbox](https://comp4020-final-yarramoo.fly.dev/sandbox). Both persist across
restarts. Still to come before the final submission: balance, polish, and a
live soak test that reaches the deep caves.

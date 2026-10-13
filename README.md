# Sandbox

## What it is

A shared falling-sand world in the browser. Everyone in it sees the same sand, water, fire and plants, live.

## What good means here (draft)

This is a draft to be argued with sources, not a settled position. The working claim from the design: the world is exactly the same for everyone, because every browser runs the same deterministic simulation on the same ordered inputs, so it is shared rather than mirrored.

## What is enforced

A determinism suite checks that the simulation gives identical state however it is stepped, and the net tests check that clients fed the same ordered inputs agree on the world's hash.

## What I chose not to build

Accounts, chat, and a server-side simulation. The server only orders inputs and keeps the log; it never steps the world.

## Status

A draft written during the build. The argument and its sources are still to come.

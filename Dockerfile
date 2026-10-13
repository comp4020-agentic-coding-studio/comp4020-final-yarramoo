# syntax = docker/dockerfile:1

# Three stages (D-008): Rust builds sim.wasm, Vite builds the client with it,
# and a slim Node 24 image runs server/main.ts directly (built-in type
# stripping). Serves HTTP on 0.0.0.0:$PORT; README.md is published at /readme/.

# 1. sim.wasm
FROM rust:1-slim AS sim
RUN rustup target add wasm32-unknown-unknown
WORKDIR /build
COPY sim ./sim
RUN cargo build --manifest-path sim/Cargo.toml --target wasm32-unknown-unknown --release --locked

# 2. client bundle (dev dependencies needed for Vite)
FROM node:24-slim AS client
RUN npm i -g pnpm@11
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY client ./client
COPY shared ./shared
COPY --from=sim /build/sim/target/wasm32-unknown-unknown/release/sim.wasm ./sim/target/wasm32-unknown-unknown/release/sim.wasm
RUN pnpm build:client:only

# 3. runtime
FROM node:24-slim
RUN npm i -g pnpm@11
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY server ./server
COPY shared ./shared
COPY README.md ./
COPY --from=sim /build/sim/target/wasm32-unknown-unknown/release/sim.wasm ./sim/target/wasm32-unknown-unknown/release/sim.wasm
COPY --from=client /app/dist/client ./dist/client
ENV DATA_DIR=/data
ENV NODE_ENV=production
CMD ["node", "server/main.ts"]

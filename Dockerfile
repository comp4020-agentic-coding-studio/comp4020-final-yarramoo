# syntax = docker/dockerfile:1

# Node 24 runs the TypeScript directly (built-in type stripping): no build step.
# Serves HTTP on 0.0.0.0:$PORT and publishes README.md at /readme/.
FROM node:24-slim
RUN npm i -g pnpm@11
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
COPY public ./public
COPY data ./data
COPY README.md PHILOSOPHY.md ./
ENV DATA_DIR=/data
ENV NODE_ENV=production
CMD ["node", "src/server.ts"]

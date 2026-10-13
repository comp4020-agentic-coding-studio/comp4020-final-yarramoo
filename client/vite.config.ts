import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(here, "../sim/target/wasm32-unknown-unknown/release/sim.wasm");

/** Serves the freshly built sim.wasm in dev and copies it into the build. The wasm is not committed. */
function simWasm(): Plugin {
  return {
    name: "sim-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/sim.wasm") return next();
        if (!existsSync(WASM)) {
          res.statusCode = 404;
          res.end("sim.wasm not built: run pnpm build:sim");
          return;
        }
        res.setHeader("content-type", "application/wasm");
        res.end(readFileSync(WASM));
      });
    },
    writeBundle(opts) {
      if (!existsSync(WASM)) throw new Error("sim.wasm not built: run pnpm build:sim first");
      const out = opts.dir ?? resolve(here, "../dist/client");
      mkdirSync(out, { recursive: true });
      copyFileSync(WASM, resolve(out, "sim.wasm"));
    },
  };
}

export default defineConfig({
  root: here,
  base: "./",
  plugins: [simWasm()],
  worker: { format: "es" },
  server: { port: 5173, strictPort: true, fs: { allow: [resolve(here, "..")] } },
  build: { outDir: resolve(here, "../dist/client"), emptyOutDir: true, target: "es2022" },
});

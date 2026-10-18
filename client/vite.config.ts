import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(here, "../sim/target/wasm32-unknown-unknown/release/sim.wasm");
// Dev-only build where Paint also works in game worlds (cargo feature dev_paint). Dev server only.
const WASM_DEV = resolve(here, "../sim/target-devpaint/wasm32-unknown-unknown/release/sim.wasm");

/** Serves the freshly built sim.wasm in dev and copies it into the build. The wasm is not committed. */
function simWasm(): Plugin {
  return {
    name: "sim-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        const file = url === "/sim.wasm" ? WASM : url === "/sim-dev.wasm" ? WASM_DEV : null;
        if (!file) return next();
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end("wasm not built: run pnpm build:sim (and build:sim:devpaint)");
          return;
        }
        res.setHeader("content-type", "application/wasm");
        res.end(readFileSync(file));
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

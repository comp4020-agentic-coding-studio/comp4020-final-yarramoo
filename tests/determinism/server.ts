// Tiny static server for the browser runner. Strips TypeScript types on the fly
// so the page can import .ts modules directly.
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize } from "node:path";
import { root } from "./helpers.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".ts": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

export async function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
      if (path.includes("..")) throw new Error("bad path");
      let body: string | Buffer = await readFile(join(root, path));
      const ext = extname(path);
      if (ext === ".ts") body = stripTypeScriptTypes(body.toString("utf8"));
      res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

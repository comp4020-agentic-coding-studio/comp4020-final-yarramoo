import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { html } from "hono/html";
import "./db/index.ts";
import { csrfGuard } from "./auth.ts";
import { flushRooms, startRooms } from "./game/rooms.ts";
import { agency } from "./routes/agency.ts";
import { mission } from "./routes/mission.ts";
import { crewPages } from "./routes/crew-pages.ts";
import { history } from "./routes/history.ts";
import { home } from "./routes/home.ts";
import { readme } from "./routes/readme.ts";
import { page } from "./views/layout.ts";

const app = new Hono();

app.use("/public/*", serveStatic({ root: "./", onFound: (_p, c) => { c.header("Cache-Control", "public, max-age=300"); } }));

// Nothing here takes a large body: forms and a few short fields. Refuse the rest
// before anything (the CSRF guard included) reads it. Hono checks Content-Length
// and, for chunked bodies, counts bytes as they stream.
app.use("*", async (c, next) => {
  if (c.req.method !== "POST") return next();
  return bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.text("Request body too large", 413) })(c, next);
});

// Every POST, in every route module, must carry a valid `_csrf` field.
app.use("*", csrfGuard);

// Route modules mount here; later slices add theirs below.
app.route("/", home);
app.route("/", mission);
app.route("/", history);
app.route("/", crewPages);
app.route("/", agency);
app.route("/", readme);

app.notFound((c) => page(c, { title: "Not found", body: html`<h1>Not found</h1>`, status: 404 }));
app.onError((e, c) => {
  console.error(e);
  return page(c, { title: "Error", body: html`<h1>Something went wrong</h1>`, status: 500 });
});

startRooms();
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    flushRooms();
    process.exit(0);
  });
}

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`listening on :${port}`));

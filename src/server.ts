import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { html } from "hono/html";
import "./db/index.ts";
import { csrfGuard } from "./auth.ts";
import { admin } from "./routes/admin.ts";
import { busRoutes } from "./bus.ts";
import { accounts } from "./routes/accounts.ts";
import { board } from "./routes/board.ts";
import { browse } from "./routes/browse.ts";
import { projects } from "./routes/projects.ts";
import { regions } from "./routes/regions.ts";
import { requests } from "./routes/requests.ts";
import { readme } from "./routes/readme.ts";
import { updates, updatesBodyLimit } from "./routes/updates.ts";
import { style } from "./routes/style.ts"; // TEMPORARY theme switcher
import { page } from "./views/layout.ts";

const app = new Hono();

app.use("/public/*", serveStatic({ root: "./", onFound: (_p, c) => { c.header("Cache-Control", "public, max-age=300"); } }));

// Cap upload size before the CSRF guard buffers the body.
app.use("/projects/:id/updates", updatesBodyLimit);

// Every POST, in every route module, must carry a valid `_csrf` field.
app.use("*", csrfGuard);

// Route modules mount here; later slices add theirs below.
app.route("/", busRoutes);
app.route("/", accounts);
app.route("/", readme);
app.route("/", projects);
app.route("/", browse);
app.route("/", regions);
app.route("/", requests);
app.route("/", updates);
app.route("/", board);
app.route("/", admin);
app.route("/", style); // TEMPORARY theme switcher

app.notFound((c) => page(c, { title: "Not found", body: html`<h1>Not found</h1>`, status: 404 }));
app.onError((e, c) => {
  console.error(e);
  return page(c, { title: "Error", body: html`<h1>Something went wrong</h1>`, status: 500 });
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`listening on :${port}`));

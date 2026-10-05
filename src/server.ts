import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { html } from "hono/html";
import "./db/index.ts";
import { csrfGuard } from "./auth.ts";
import { busRoutes } from "./bus.ts";
import { accounts } from "./routes/accounts.ts";
import { browse } from "./routes/browse.ts";
import { projects } from "./routes/projects.ts";
import { readme } from "./routes/readme.ts";
import { page } from "./views/layout.ts";

const app = new Hono();

app.use("/public/*", serveStatic({ root: "./", onFound: (_p, c) => { c.header("Cache-Control", "public, max-age=300"); } }));

// Every POST, in every route module, must carry a valid `_csrf` field.
app.use("*", csrfGuard);

// Route modules mount here; later slices add theirs below.
app.route("/", busRoutes);
app.route("/", accounts);
app.route("/", readme);
app.route("/", projects);
app.route("/", browse);

app.notFound((c) => page(c, { title: "Not found", body: html`<h1>Not found</h1>`, status: 404 }));
app.onError((e, c) => {
  console.error(e);
  return page(c, { title: "Error", body: html`<h1>Something went wrong</h1>`, status: 500 });
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`listening on :${port}`));

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { html } from "hono/html";
import "./db/index.ts";
import { busRoutes } from "./bus.ts";
import { accounts } from "./routes/accounts.ts";
import { readme } from "./routes/readme.ts";
import { page } from "./views/layout.ts";

const app = new Hono();

app.use("/public/*", serveStatic({ root: "./", onFound: (_p, c) => { c.header("Cache-Control", "public, max-age=300"); } }));

// Route modules mount here; later slices add theirs below.
app.route("/", busRoutes);
app.route("/", accounts);
app.route("/", readme);

app.get("/", (c) => page(c, { title: "Browse", body: html`<h1>Browse projects</h1><p>Browse coming soon.</p>` }));

app.notFound((c) => page(c, { title: "Not found", body: html`<h1>Not found</h1>`, status: 404 }));
app.onError((e, c) => {
  console.error(e);
  return page(c, { title: "Error", body: html`<h1>Something went wrong</h1>`, status: 500 });
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`listening on :${port}`));

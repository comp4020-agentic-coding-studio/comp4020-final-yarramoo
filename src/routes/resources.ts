import { Hono } from "hono";
import { html } from "hono/html";
import { RESOURCE_GROUPS, RESOURCES_INTRO } from "../resources.ts";
import { page } from "../views/layout.ts";

export const resources = new Hono();

resources.get("/resources", (c) =>
  page(c, {
    title: "Resources",
    body: html`<h1>Resources</h1>
<p class="lead">${RESOURCES_INTRO}</p>
${RESOURCE_GROUPS.filter((g) => g.tools.length).map((g) => html`<section class="resource-group"><h2>${g.title}</h2>
<ul class="resource-list">${g.tools.map((t) => html`<li><a href="${t.url}" rel="noopener" target="_blank">${t.name}</a> <span class="muted">${t.note}</span></li>`)}</ul></section>`)}`,
  }));

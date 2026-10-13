import { Hono } from "hono";
import { html, raw } from "hono/html";
import { marked } from "marked";
import { readFileSync } from "node:fs";
import { page } from "../views/layout.ts";

export const readme = new Hono();

const file = new URL("../../README.md", import.meta.url);
const philosophy = new URL("../../PHILOSOPHY.md", import.meta.url);

// Rendered per request: these files are tiny and this keeps the pages in sync with them.
// marked passes raw HTML through; both files are author-controlled, not user input.
const render = (f: URL) => marked.parse(readFileSync(f, "utf8"), { async: false });

readme.get("/readme/", (c) => page(c, { title: "About", body: html`<article class="prose">${raw(render(file))}</article>` }));

readme.get("/philosophy", (c) => page(c, { title: "Why this place exists", body: html`<article class="prose">${raw(render(philosophy))}</article>` }));

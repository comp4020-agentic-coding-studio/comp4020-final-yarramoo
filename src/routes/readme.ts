import { Hono } from "hono";
import { html, raw } from "hono/html";
import { marked } from "marked";
import { readFileSync } from "node:fs";
import { page } from "../views/layout.ts";

export const readme = new Hono();

const file = new URL("../../README.md", import.meta.url);

// Rendered per request: the file is tiny and this keeps the page in sync with it.
// marked passes raw HTML through; README.md is author-controlled, not user input.
readme.get("/readme/", (c) => page(c, { title: "About", body: html`<article class="prose">${raw(marked.parse(readFileSync(file, "utf8"), { async: false }))}</article>` }));

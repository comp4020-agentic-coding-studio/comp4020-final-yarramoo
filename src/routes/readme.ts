import { Hono } from "hono";
import { html, raw } from "hono/html";
import { marked } from "marked";
import { readFileSync } from "node:fs";
import { page } from "../views/layout.ts";

export const readme = new Hono();

const file = new URL("../../README.md", import.meta.url);

readme.get("/readme/", (c) => {
  // Rendered per request: README.md is tiny and this keeps it in sync with the file.
  // marked passes raw HTML through; README.md is author-controlled, not user input.
  const body = marked.parse(readFileSync(file, "utf8"), { async: false });
  return page(c, { title: "About", body: html`<article class="prose">${raw(body)}</article>` });
});

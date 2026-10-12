import { Hono } from "hono";
import { html } from "hono/html";
import { page } from "../views/layout.ts";

export const home = new Hono();

home.get("/", (c) => page(c, { title: "Mission Control", body: html`<h1>Mission Control</h1><p>Mission Control — under construction</p>` }));

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { currentSession } from "./auth.ts";

export type BusEvent = { type: string; html?: string; data?: unknown };
type Fn = (e: BusEvent) => void;

// Topics: `project:<id>`, `question:<id>`, `user:<id>`, `feed`, `activity`. Every event goes out as an
// unnamed SSE message with its `type` in the JSON payload, so the client needs
// no list of event names and a new type can never be silently dropped.
const subs = new Map<string, Set<Fn>>();

export function publish(topic: string, event: BusEvent): void {
  for (const fn of subs.get(topic) ?? []) {
    try { fn(event); } catch { /* a dead subscriber must not break publishers */ }
  }
}

export function subscribe(topic: string, fn: Fn): () => void {
  let set = subs.get(topic);
  if (!set) subs.set(topic, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) subs.delete(topic);
  };
}

export const busRoutes = new Hono();

busRoutes.get("/events", (c) => {
  const s = currentSession(c);
  const topics = [...new Set(c.req.queries("topic") ?? [])]
    .filter((t) => t === "feed" || t === "activity" || /^project:\d+$/.test(t) || /^question:\d+$/.test(t) || (s && t === `user:${s.user_id}`))
    .slice(0, 20);
  return streamSSE(c, async (stream) => {
    const unsubs = topics.map((t) =>
      subscribe(t, (e) => {
        stream.writeSSE({ data: JSON.stringify({ topic: t, ...e }) }).catch(() => {});
      }),
    );
    const done = new Promise<void>((resolve) => stream.onAbort(resolve));
    await stream.writeSSE({ data: JSON.stringify({ type: "ready", topics }) });
    const beat = setInterval(() => { stream.write(": hb\n\n").catch(() => {}); }, 25_000);
    await done;
    clearInterval(beat);
    unsubs.forEach((u) => u());
  });
});

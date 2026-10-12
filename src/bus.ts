// Internal pub/sub. There is no public route onto it: the only subscriber is
// the per-seat stream in routes/mission.ts, which subscribes a crew member to
// the topics for the roles they hold. Topics are `mission:<CODE>:<role>` and
// `mission:<CODE>:lobby`.
export type BusEvent = { type: string; [key: string]: unknown };
type Fn = (e: BusEvent) => void;

const subs = new Map<string, Set<Fn>>();

export function publish(topic: string, event: BusEvent): void {
  for (const fn of subs.get(topic) ?? []) {
    try { fn(event); } catch { /* a dead subscriber must not break publishers */ }
  }
}

export function hasSubscribers(topic: string): boolean {
  return (subs.get(topic)?.size ?? 0) > 0;
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

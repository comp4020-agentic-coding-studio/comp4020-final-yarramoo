// Hash routes for the menu. Pure (no DOM): every step is linkable and Back walks the tree.
export type Route =
  | { kind: "title" }
  | { kind: "types" }
  | { kind: "settings"; type: "survival" | "deathmatch" }
  | { kind: "join" }
  | { kind: "mine" }
  | { kind: "share"; code: string };

/** Unknown hashes and malformed codes map to the title. */
export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const title: Route = { kind: "title" };
  if (h === "") return title;
  const parts = h.split("/");
  if (parts.length === 1 && h === "new") return { kind: "types" };
  if (parts.length === 1 && h === "join") return { kind: "join" };
  if (parts.length === 1 && h === "mine") return { kind: "mine" };
  if (parts.length === 2 && parts[0] === "new" && (parts[1] === "survival" || parts[1] === "deathmatch")) {
    return { kind: "settings", type: parts[1] };
  }
  if (parts.length === 2 && parts[0] === "share") {
    const code = parts[1].toUpperCase();
    if (/^[A-Z0-9]{1,6}$/.test(code)) return { kind: "share", code };
  }
  return title;
}

export function formatRoute(r: Route): string {
  switch (r.kind) {
    case "title": return "";
    case "types": return "#new";
    case "settings": return `#new/${r.type}`;
    case "join": return "#join";
    case "mine": return "#mine";
    case "share": return `#share/${r.code}`;
  }
}

/** The screen one step up the tree. */
export function parentRoute(r: Route): Route {
  return r.kind === "settings" ? { kind: "types" } : { kind: "title" };
}

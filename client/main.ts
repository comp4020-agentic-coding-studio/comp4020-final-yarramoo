// Entry point: routes between the menu (R3, "/") and a room page (/sandbox, /game, /r/<code>) by
// location.pathname, the same pattern worldId used to pick a fixed world, just with a third branch
// (docs/plan-game-modes.md "All routes serve the same bundle").
import { resolveRoomTarget, startRoom } from "./room.ts";
import { startMenu } from "./menu.ts";

const menuRoot = document.getElementById("menu-root") as HTMLDivElement;
const roomRoot = document.getElementById("room-root") as HTMLDivElement;

const clean = location.pathname.replace(/\/+$/, "") || "/";
if (clean === "/") {
  menuRoot.hidden = false;
  startMenu(menuRoot);
} else {
  roomRoot.hidden = false;
  resolveRoomTarget(location.pathname)
    .then((target) => startRoom(target))
    .catch((err) => {
      const note = document.getElementById("note");
      if (note) {
        note.hidden = false;
        note.textContent = String((err as Error)?.message ?? err);
      }
      console.error("[main] failed to resolve room target", err);
    });
}

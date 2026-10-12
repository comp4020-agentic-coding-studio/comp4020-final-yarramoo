// Mounts the 3D scene behind the HTML console, and unmounts it when the player
// switches to the 2D view. console.js owns the stream, the panel and the 2D
// toggle; it publishes three public events and this file listens:
//   mc:state  { lobby, myRoles, activeRole, sequenceId, clockMs, clockAt, clockPhase }  (public lobby, my roles, the mission clock)
//   mc:seat   { activeRole }                              (tab changed)
//   mc:layout { right, bottom }                           (px of the canvas the overlay covers)
//   mc:view   { mode: "3d" | "2d" }
//   mc:zoom { ratio }, mc:recentre {}                      (the +/- and Look buttons)
//   mc:gesture { type, role, kind, at }                   (another seat acted: kind only, never what)
//   mc:look    { type, heads: { role: [yaw, pitch] } }    (where seats are looking)
// and the scene emits mc:mylook { yaw, pitch } for console.js to throttle and post.
// Console views are never published, so the scene cannot read them.
const root = document.getElementById("mission");
const container = document.getElementById("scene");

if (root && container) {
  let handle = null;
  let loading = false;
  let last = { lobby: null, myRoles: [], activeRole: null, sequenceId: root.dataset.sequence };
  const roles = [...document.querySelectorAll("#seats li[data-role]")].map((li) => li.dataset.role);

  const insets = () => {
    const l = (window.__mc && window.__mc.layout) || { right: 0, bottom: 0 };
    return [l.right, l.bottom];
  };

  async function mount() {
    if (handle || loading) return;
    loading = true;
    try {
      const { mountScene } = await import("/public/scene/scene.js");
      if (root.dataset.view !== "3d") return; // switched to 2D while loading
      handle = mountScene(container, { sequenceId: root.dataset.sequence, ascentSec: root.dataset.ascentSec, roles, initial: last });
      handle.setInsets(...insets());
      if (window.__mc && window.__mc.heads) handle.looks(window.__mc.heads); // heads received before the scene existed
    } catch (e) {
      console.error("3D scene unavailable, using the 2D view", e);
      window.dispatchEvent(new CustomEvent("mc:scene-error"));
    } finally {
      loading = false;
    }
  }

  function unmount() {
    if (!handle) return;
    handle.dispose();
    handle = null;
  }

  window.addEventListener("mc:state", (e) => { last = e.detail; if (handle) handle.update(last); });
  window.addEventListener("mc:seat", (e) => {
    last = { ...last, activeRole: e.detail.activeRole };
    if (handle) handle.update(last);
  });
  window.addEventListener("mc:gesture", (e) => { if (handle) handle.gesture(e.detail.role, e.detail.kind); });
  window.addEventListener("mc:look", (e) => { if (handle) handle.looks(e.detail.heads); });
  window.addEventListener("mc:layout", (e) => { if (handle) handle.setInsets(e.detail.right, e.detail.bottom); });
  window.addEventListener("mc:zoom", (e) => { if (handle) handle.zoomBy(e.detail.ratio); });
  window.addEventListener("mc:recentre", () => { if (handle) handle.recentre(); });
  window.addEventListener("mc:view", (e) => (e.detail.mode === "3d" ? mount() : unmount()));

  if (window.__mc && window.__mc.state) last = window.__mc.state;
  if (root.dataset.view === "3d") mount();
}

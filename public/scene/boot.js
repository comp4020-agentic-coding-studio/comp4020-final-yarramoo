// Mounts the 3D scene behind the HTML console, and unmounts it when the player
// switches to the 2D view. console.js owns the stream, the panel and the 2D
// toggle; it publishes three public events and this file listens:
//   mc:state  { lobby, myRoles, activeRole, sequenceId }  (public lobby data and my own roles)
//   mc:seat   { activeRole }                              (tab changed)
//   mc:layout { right, bottom }                           (px of the canvas the overlay covers)
//   mc:view   { mode: "3d" | "2d" }
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
      handle = mountScene(container, { sequenceId: root.dataset.sequence, roles, initial: last });
      handle.setInsets(...insets());
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
  window.addEventListener("mc:layout", (e) => { if (handle) handle.setInsets(e.detail.right, e.detail.bottom); });
  window.addEventListener("mc:view", (e) => (e.detail.mode === "3d" ? mount() : unmount()));

  if (window.__mc && window.__mc.state) last = window.__mc.state;
  if (root.dataset.view === "3d") mount();
}

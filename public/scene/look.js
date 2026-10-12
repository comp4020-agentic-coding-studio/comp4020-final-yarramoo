// First-person look controls with no pointer lock: drag with mouse, pen or
// touch to turn (grab-the-world style, so the scene follows your finger), arrow
// keys to turn, gentle inertia after a flick. yaw is an offset from the
// camera's home heading (facing the pad); pitch is clamped.
export function createLook(el, { radPerPx, onChange, onZoom = () => {}, onReset = () => {}, minPitch = -1.1, maxPitch = 1.35 }) {
  const look = { yaw: 0, pitch: 0, dragging: false };
  let vyaw = 0, vpitch = 0; // inertia, rad/s
  let keyYaw = 0, keyPitch = 0; // held arrow keys, -1..1
  let pid = null, lx = 0, ly = 0, lt = 0;
  const clamp = () => { look.pitch = Math.max(minPitch, Math.min(maxPitch, look.pitch)); look.yaw = Math.atan2(Math.sin(look.yaw), Math.cos(look.yaw)); };

  el.style.touchAction = "none";
  el.style.cursor = "grab";

  // A second finger turns the drag into a pinch (onZoom gets the spread ratio since
  // the last move); a quick second tap in place resets (onReset).
  const pts = new Map();
  let pinchD = 0, tap = { t: 0, x: 0, y: 0 }, moved = 0, downAt = 0;
  const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const down = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
    if (pts.size === 2) { pinchD = spread(); look.dragging = false; pid = null; vyaw = vpitch = 0; moved = 99; return; }
    if (pid !== null || pts.size > 2) return;
    pid = e.pointerId; lx = e.clientX; ly = e.clientY; lt = e.timeStamp;
    moved = 0; downAt = e.timeStamp;
    look.dragging = true; vyaw = vpitch = 0;
    el.style.cursor = "grabbing";
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  };
  const move = (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2) {
      const d = spread();
      if (pinchD > 0 && d > 0) { onZoom(d / pinchD); pinchD = d; }
      return;
    }
    if (e.pointerId !== pid) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    moved += Math.abs(dx) + Math.abs(dy);
    const dt = Math.max(1, e.timeStamp - lt) / 1000;
    lx = e.clientX; ly = e.clientY; lt = e.timeStamp;
    const k = radPerPx();
    look.yaw += dx * k; look.pitch += dy * k;
    // Smoothed velocity for the flick.
    vyaw = vyaw * 0.6 + ((dx * k) / dt) * 0.4;
    vpitch = vpitch * 0.6 + ((dy * k) / dt) * 0.4;
    clamp(); onChange();
  };
  const up = (e) => {
    const was = pts.size;
    pts.delete(e.pointerId);
    try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (was >= 2) { pinchD = 0; if (pts.size === 0) { pid = null; look.dragging = false; } return; }
    if (e.pointerId !== pid) return;
    if (e.type === "pointerup" && moved < 8 && e.timeStamp - downAt < 350) {
      if (e.timeStamp - tap.t < 350 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 30) { tap.t = 0; onReset(); }
      else tap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    }
    pid = null; look.dragging = false; el.style.cursor = "grab";
    if (e.timeStamp - lt > 90) vyaw = vpitch = 0; // held still before letting go: no flick
    const cap = 4;
    vyaw = Math.max(-cap, Math.min(cap, vyaw)); vpitch = Math.max(-cap, Math.min(cap, vpitch));
    onChange();
  };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  const wheel = (e) => { e.preventDefault(); onZoom(Math.exp(-Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0016 * (e.deltaMode ? 20 : 1))); };
  el.addEventListener("wheel", wheel, { passive: false });
  const dbl = () => onReset();
  el.addEventListener("dblclick", dbl);

  const KEYS = { ArrowLeft: ["yaw", 1], ArrowRight: ["yaw", -1], ArrowUp: ["pitch", 1], ArrowDown: ["pitch", -1] };
  const typing = (t) => t instanceof Element && (t.closest("input, textarea, select, button, a, [contenteditable]") || t.closest("#overlay"));
  const keydown = (e) => {
    const k = KEYS[e.key];
    if (!k || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    e.preventDefault();
    if (k[0] === "yaw") keyYaw = k[1]; else keyPitch = k[1];
    onChange();
  };
  const keyup = (e) => {
    const k = KEYS[e.key];
    if (!k) return;
    if (k[0] === "yaw" && keyYaw === k[1]) keyYaw = 0;
    if (k[0] === "pitch" && keyPitch === k[1]) keyPitch = 0;
  };
  const blur = () => { keyYaw = keyPitch = 0; };
  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);
  window.addEventListener("blur", blur);

  /** Advance by dt seconds; true while still moving (so the caller keeps rendering). */
  look.step = (dt) => {
    let moving = look.dragging || keyYaw !== 0 || keyPitch !== 0;
    if (keyYaw || keyPitch) { look.yaw += keyYaw * 1.4 * dt; look.pitch += keyPitch * 1.0 * dt; }
    if (!look.dragging && (Math.abs(vyaw) > 0.01 || Math.abs(vpitch) > 0.01)) {
      look.yaw += vyaw * dt; look.pitch += vpitch * dt;
      const damp = Math.exp(-dt * 4.5);
      vyaw *= damp; vpitch *= damp;
      moving = true;
    }
    clamp();
    return moving;
  };
  look.stop = () => { vyaw = vpitch = 0; };
  look.set = (yaw, pitch) => { look.yaw = yaw; look.pitch = pitch; clamp(); };
  look.dispose = () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    el.removeEventListener("wheel", wheel);
    el.removeEventListener("dblclick", dbl);
    window.removeEventListener("keydown", keydown);
    window.removeEventListener("keyup", keyup);
    window.removeEventListener("blur", blur);
    el.style.cursor = "";
  };
  return look;
}

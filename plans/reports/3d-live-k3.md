# Live Kestrel-3 flight in 3D (session, 2026-10-13)

One session held all five seats; a scripted crew did every ready step, held
for weather, reported GO, and as Range terminated only if Propulsion's
cross-check read ABNORMAL. Real flight, no preview: liftoff at T-0; a real
anomaly appeared in ascent; the cross-check read ABNORMAL; Range terminated at
T+11 s: "correct call". Board, incident report and agency all agreed.

Found: from the Flight Director's seat the climb passed behind the tower and
the camera only tilted (never turned), so the termination flash happened
off-screen (`3d-live-k3-ascent.png`, `3d-live-k3-end.png`). Fixed:
- the camera follows the vehicle in yaw and pitch for the whole climb, and
  holds on the point of an in-air end for 6 s so its flash is framed;
- the tower fades to 0.28 opacity while it stands between a camera and the
  vehicle (measured: faded T+3 to T+14 from that seat, solid again after).
Re-shot: `3d-follow-terminate.png` shows the burst mid-frame.

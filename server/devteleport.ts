// Dev-only teleport (brief HB): lets a Pos jump any distance so a scripted run can reach the boss arena in a real
// room. Off by default, and refused whenever the process looks like production. The server decides; a client that
// claims the flag on a server without it is simply rejected by `PosBaselines` like any teleport.
export const DEV_TELEPORT_ENV = "SIMULTA_DEV_TELEPORT";

export interface DevTeleportDecision {
  on: boolean;
  /** Asked for but refused because the environment is production. */
  refused: boolean;
}

/** `requested` defaults to the env var being "1". Production (NODE_ENV=production or any FLY_APP_NAME) always refuses. */
export function resolveDevTeleport(env: Record<string, string | undefined>, requested?: boolean): DevTeleportDecision {
  const want = requested ?? env[DEV_TELEPORT_ENV] === "1";
  if (!want) return { on: false, refused: false };
  if (env.NODE_ENV === "production" || !!env.FLY_APP_NAME) return { on: false, refused: true };
  return { on: true, refused: false };
}

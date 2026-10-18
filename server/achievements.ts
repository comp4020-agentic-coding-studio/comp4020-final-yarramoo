// Server-countable achievements (plan 10, M6 slice a). After a stat changes, re-check only the not-yet-earned
// achievements that watch that stat. Earned ids are cached per visitor (loaded from the database the first time the
// visitor is touched), so a Pos or Cast input costs a couple of Set lookups once everything relevant is earned.
// Never reads or writes sim state. Visitor 0 (anonymous) earns nothing.
import { BACK_FROM_THE_DEAD_DEATHS, FIRST_BLOOD_KILLS, FIVE_KILLS, SERVER_ACHIEVEMENTS, SHOVE_CAUSES, achievementById } from "../shared/achievements.ts";
import { STAT_DEATHS, STAT_KILLS } from "../shared/stats.ts";
import type { GameDb } from "./db.ts";
import type { EventLog } from "./log.ts";
import type { PlayerStats } from "./stats.ts";

export interface AwardContext {
  /** The visitor's plain display name; the log line gets `name#id`. */
  name: string;
  world: number;
  tick: number;
}

export class Achievements {
  private readonly earned = new Map<number, Set<string>>();
  private readonly db: GameDb | null;
  private readonly stats: PlayerStats;
  private readonly log: EventLog;
  private readonly deliver: (visitorId: number, achievementId: string, tick: number) => void;

  constructor(db: GameDb | null, stats: PlayerStats, log: EventLog, deliver: (visitorId: number, achievementId: string, tick: number) => void) {
    this.db = db;
    this.stats = stats;
    this.log = log;
    this.deliver = deliver;
  }

  private of(id: number): Set<string> {
    let s = this.earned.get(id);
    if (!s) this.earned.set(id, (s = new Set(this.db ? this.db.achievementsOf(id) : [])));
    return s;
  }

  /** Ids this visitor has earned (a copy). */
  earnedBy(visitorId: number): string[] {
    return visitorId ? [...this.of(visitorId)] : [];
  }

  /** Call after `stat` changed for `visitorId`. Awards each newly satisfied achievement exactly once. */
  onStat(visitorId: number, stat: string, ctx: AwardContext): void {
    if (!visitorId) return;
    const have = this.of(visitorId);
    let totals: Record<string, number> | undefined;
    for (const a of SERVER_ACHIEVEMENTS) {
      if (have.has(a.id) || !stat.startsWith(a.on)) continue;
      totals ??= this.stats.get(visitorId);
      if (a.check(totals)) this.grant(visitorId, a.id, ctx);
    }
  }

  /** Count one majority-agreed death (D-120): kills and deaths stats, then the four claim achievements. */
  onDeath(victim: number, killer: number, cause: number, ctxOf: (visitorId: number) => AwardContext): void {
    if (victim) {
      this.stats.bump(victim, STAT_DEATHS);
      if ((this.stats.get(victim)[STAT_DEATHS] ?? 0) >= BACK_FROM_THE_DEAD_DEATHS) this.grant(victim, "back_from_the_dead", ctxOf(victim));
    }
    if (killer && killer !== victim) {
      this.stats.bump(killer, STAT_KILLS);
      const kills = this.stats.get(killer)[STAT_KILLS] ?? 0;
      if (kills >= FIRST_BLOOD_KILLS) this.grant(killer, "first_blood", ctxOf(killer));
      if (kills >= FIVE_KILLS) this.grant(killer, "five_kills", ctxOf(killer));
      if (SHOVE_CAUSES.includes(cause)) this.grant(killer, "shoved_to_doom", ctxOf(killer));
    }
  }

  /** Award `id` once ever (cache, `insert or ignore`, then delivery to the earner's connections). Unknown ids are ignored. */
  grant(visitorId: number, id: string, ctx: AwardContext): void {
    const a = achievementById(id);
    if (!visitorId || !a) return;
    if (this.of(visitorId).has(id)) return;
    this.award(visitorId, a, ctx);
  }

  private award(visitorId: number, a: { id: string }, ctx: AwardContext): void {
    const have = this.of(visitorId);
    have.add(a.id); // remembered even if the write fails, so one bad row cannot loop
    try {
      // With no database (tests) every award is new; with one, `insert or ignore` says whether it was.
      if (this.db && !this.db.awardAchievement(visitorId, a.id, ctx.world, ctx.tick)) return;
    } catch (e) {
      this.log.limited("achievement.write", 60_000, "tick_log.flush_failed", { what: "achievements", rows: 1, failed: 1, error: String(e) }, "error");
      return;
    }
    this.log.event("achievement.awarded", { who: `${ctx.name}#${visitorId}`, achievement: a.id, world: ctx.world, tick: ctx.tick });
    this.deliver(visitorId, a.id, ctx.tick);
  }
}

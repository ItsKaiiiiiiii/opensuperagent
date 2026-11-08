import type { Store } from "../storage/index.js";
import type { AppConfig } from "../config.js";
import type { SessionManager } from "../session/manager.js";

/**
 * In-process supervisor — runs on an interval.
 */
export class Supervisor {
  private timer: NodeJS.Timeout | null = null;
  private consecutiveDbFailures = 0;

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly sessions: SessionManager,
  ) {}

  start(): void {
    if (this.timer) return;
    const ms = this.config.supervisor.interval_sec * 1000;
    this.timer = setInterval(() => {
      void this.check();
    }, ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<void> {
    try {
      this.store.db.prepare("SELECT 1").get();
      this.consecutiveDbFailures = 0;
    } catch (err) {
      this.consecutiveDbFailures += 1;
      console.error("[supervisor] db write/read failure", err);
      if (this.consecutiveDbFailures >= 3) {
        console.error("[supervisor] exiting for systemd restart");
        process.exit(1);
      }
      return;
    }

    // Turn duration
    const maxMs = this.config.supervisor.max_turn_duration_sec * 1000;
    for (const run of this.store.runs.listIncomplete()) {
      if (run.status !== "submitted") continue;
      const age = Date.now() - Date.parse(run.createdAt);
      if (age > maxMs) {
        console.warn(`[supervisor] run ${run.id} exceeded max_turn_duration`);
        const session = this.store.sessions.get(run.sessionId);
        if (session) {
          const handle = this.sessions.get(session.owner);
          await handle?.abort("max_turn_duration");
        }
        this.store.runs.transition(run.id, "submitted", "aborted");
      }
    }

    // Stall detection (alert only)
    const stallMs = this.config.supervisor.stall_after_sec * 1000;
    for (const task of this.store.tasks.listOpen()) {
      const age = Date.now() - Date.parse(task.updatedAt);
      if (age > stallMs && task.status === "waiting") {
        console.warn(
          `[supervisor] task ${task.id} stalled (no progress for ${this.config.supervisor.stall_after_sec}s)`,
        );
      }
    }
  }
}

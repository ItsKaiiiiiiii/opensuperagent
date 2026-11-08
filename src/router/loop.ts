import { triggerText } from "../ingress/text.js";
import type { DataPaths } from "../paths.js";
import type { Store } from "../storage/index.js";
import type { AppConfig } from "../config.js";
import type { SessionManager } from "../session/manager.js";
import { buildRouterSystemPrompt, formatRouterBatch } from "./prompts.js";

/**
 * Router turn loop.
 * When idle + pending inbox → one Run with all pending inputs.
 * Tool side effects are performed by the session facade (Pizza).
 */
export class RouterLoop {
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly config: AppConfig,
    private readonly paths?: DataPaths,
  ) {}

  async tick(): Promise<boolean> {
    if (this.running) return false;
    if (!this.sessions.isIdle("router")) return false;

    const pending = this.store.inbox.listPending("router");
    if (
      pending.length === 0 &&
      !this.store.runs.findActive(this.sessions.ensureSession("router").id)
    )
      return false;

    this.running = true;
    try {
      const defs = this.store.catalog.listActiveDefinitions();
      const systemPrompt = buildRouterSystemPrompt(this.config, defs);
      const handle = await this.sessions.open("router", {
        systemPrompt,
        model: this.config.models.router,
      });

      const batch = this.sessions.beginRun("router", (items) => {
        const enriched = items.map((i) => {
          const t = this.store.triggers.get(i.triggerId)!;
          return {
            triggerId: t.id,
            source: t.source,
            threadId: t.threadId,
            actorId: t.actorId,
            preview: this.paths ? triggerText(this.paths, t) : t.preview,
          };
        });
        return formatRouterBatch({
          openTasks: this.store.tasks.listOpen(),
          items: enriched,
        });
      });
      if (!batch) return false;

      this.store.runs.transition(batch.run.id, "pending", "submitted");
      try {
        await handle.prompt(batch.promptText);
      } catch (error) {
        this.store.runs.transition(batch.run.id, "submitted", "failed");
        throw error;
      } finally {
        if (this.store.runs.get(batch.run.id)?.status === "submitted") {
          this.store.runs.transition(batch.run.id, "submitted", "completed");
        }
        this.store.inbox.markDone(batch.items.map((i) => i.id));
      }
      return true;
    } finally {
      this.running = false;
    }
  }
}

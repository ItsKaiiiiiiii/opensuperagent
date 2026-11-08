import { triggerText } from "../ingress/text.js";
import type { DataPaths } from "../paths.js";
import type { Store } from "../storage/index.js";
import type { SessionManager } from "../session/manager.js";
import type { InboxItem, Trigger } from "../types.js";

/**
 * Worker turn loop: one session per Task, bounded by max_active_tasks.
 * Tool side effects are performed by the session facade (Pizza).
 */
export class WorkerLoop {
  private readonly busy = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly maxConcurrent = 2,
    private readonly paths?: DataPaths,
  ) {}

  async tickAll(): Promise<number> {
    const outcomes = await Promise.allSettled(
      this.store.tasks.listOpen().map((task) => this.tick(task.id)),
    );
    const failure = outcomes.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return outcomes.filter((r) => r.status === "fulfilled" && r.value).length;
  }

  async tick(taskId: string): Promise<boolean> {
    if (this.busy.has(taskId) || this.busy.size >= this.maxConcurrent)
      return false;
    const task = this.store.tasks.get(taskId);
    if (!task || this.store.tasks.isTerminal(task.status)) return false;
    if (!this.sessions.isIdle(taskId)) return false;
    if (this.store.operations.findActiveForTask(taskId)) return false;

    const pending = this.store.inbox.listPending(taskId);
    if (
      pending.length === 0 &&
      !this.store.runs.findActive(this.sessions.ensureSession(taskId).id)
    ) {
      if (task.status === "active") {
        this.store.tasks.transition(taskId, "active", "waiting");
      }
      return false;
    }

    this.busy.add(taskId);
    try {
      if (task.status === "pending" || task.status === "waiting") {
        this.store.tasks.transition(taskId, task.status, "active");
      }

      const handle = await this.sessions.open(taskId, {
        cwd: task.workspacePath,
        systemPrompt: buildWorkerPrompt(
          task.definition.systemPrompt,
          task.definition.skills,
        ),
        model: task.definition.model,
      });

      const batch = this.sessions.beginRun(taskId, (items) => {
        const history = this.store.db
          .prepare(
            "SELECT trigger_id FROM inbox WHERE target = ? AND status = 'done' ORDER BY created_at DESC, rowid DESC LIMIT 30",
          )
          .all(taskId)
          .reverse()
          .map((row) => {
            const prior = this.store.triggers.get(String(row.trigger_id));
            return prior
              ? `- earlier input ${prior.id} (${prior.source}): ${(this.paths ? triggerText(this.paths, prior) : prior.preview).slice(0, 4000)}`
              : "";
          })
          .join("\n")
          .slice(-32000);
        const operation = this.store.operations.findActiveForTask(taskId);
        return (
          `## Task objective\n${task.objective}\n\n## Runtime state\nCurrent UTC time: ${new Date().toISOString()}\nWorkspace: ${task.workspacePath}\nActive operation: ${operation ? `${operation.id} (${operation.status}), deadline=${operation.deadlineAt}. Do not poll or write while busy; wait for its completion event.` : "none"}\n\n## Earlier processed inputs (context; preserve outstanding requirements, do not repeat completed side effects)\n${history || "(none)"}\n\n## New inputs\n` +
          formatWorkerBatch(
            orderInbox(items).map((i) => ({
              item: i,
              trigger: (() => {
                const t = this.store.triggers.get(i.triggerId)!;
                return this.paths
                  ? { ...t, preview: triggerText(this.paths, t) }
                  : t;
              })(),
            })),
          )
        );
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

      const still = this.store.inbox.listPending(taskId);
      const fresh = this.store.tasks.get(taskId);
      if (
        fresh &&
        !this.store.tasks.isTerminal(fresh.status) &&
        still.length === 0
      ) {
        this.store.tasks.transition(taskId, "active", "waiting");
      }
      return true;
    } finally {
      this.busy.delete(taskId);
    }
  }

  notifyOperationComplete(operationId: string): void {
    const op = this.store.operations.get(operationId);
    if (!op) return;
    const externalId = `operation:${operationId}`;
    if (this.store.triggers.findByExternal("system", externalId)) return;

    this.store.transaction(() => {
      const trigger = this.store.triggers.insert({
        source: "system",
        externalId,
        threadId: null,
        actorId: "system",
        payloadRef: `op:${operationId}`,
        preview: `Operation ${operationId} ${op.status} (exit ${op.exitCode})`,
        status: "routed",
      });
      this.store.inbox.insertOrGet({
        target: op.taskId,
        triggerId: trigger.id,
      });
    });
  }
}

function orderInbox(items: InboxItem[]): InboxItem[] {
  const steer = items.filter((i) => i.steer);
  const rest = items.filter((i) => !i.steer);
  return [...steer, ...rest];
}

function buildWorkerPrompt(systemPrompt: string, skills: string[]): string {
  const skillLines =
    skills.length === 0
      ? ""
      : `\n\nAvailable skills (use _skill through cli, or read the snapshot files listed by Pizza):\n${skills.map((s) => `- ${s}`).join("\n")}`;
  return `${systemPrompt}\n\nTool interface: the only model tool is Pizza native cli. Use _read/_write/_edit for file operations, _skill list/load/read for skills, and authorized shell commands for execution. cli.timeout is in milliseconds and commands wait for completion. Submit results with _submit_result --outcome completed --notice TEXT --summary TEXT; choose failed or needs_input when appropriate. Quote text values. Run _submit_result --help for JSON/heredoc input. It is always available.${skillLines}`;
}

function formatWorkerBatch(
  rows: { item: InboxItem; trigger: Trigger }[],
): string {
  return rows
    .map(({ item, trigger }) => {
      const flag = item.steer ? " [STEER]" : "";
      return `-${flag} trigger=${trigger.id} source=${trigger.source}: ${trigger.preview}`;
    })
    .join("\n");
}

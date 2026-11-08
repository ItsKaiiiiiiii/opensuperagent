import { validateWorkerTools } from "../worker/definition.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "../storage/index.js";
import type { DataPaths } from "../paths.js";
import type { DeliveryService } from "../delivery/index.js";
import type { WorkspaceManager } from "../execution/workspace.js";
import { snapshotSkillsForTask } from "../catalog/index.js";
import type { Task, WorkerDefinitionSpec } from "../types.js";
import { nowIso } from "../ids.js";

/**
 * Router side-effecting tools.
 * Each call is idempotent via tool_actions (session_id, tool_call_id).
 */
export class RouterTools {
  constructor(
    private readonly store: Store,
    private readonly paths: DataPaths,
    private readonly delivery: DeliveryService,
    private readonly workspaces: WorkspaceManager,
    private readonly onStop?: (
      taskId: string,
      operationId: string | null,
    ) => void,
  ) {}

  listTasks(): Task[] {
    return this.store.tasks.listOpen();
  }

  readTask(taskId: string): Task | null {
    return this.store.tasks.get(taskId);
  }

  readTrigger(triggerId: string) {
    return this.store.triggers.get(triggerId);
  }

  startTask(input: {
    sessionId: string;
    toolCallId: string;
    runId: string;
    triggerIds: string[];
    definition: string;
    objective: string;
    ownerId?: string;
  }): { taskId: string; created: boolean } {
    const existing = this.store.toolActions.get(
      input.sessionId,
      input.toolCallId,
    );
    if (existing) {
      return existing.result as { taskId: string; created: boolean };
    }

    // Same trigger can only be assigned once.
    for (const tid of input.triggerIds) {
      const prior = this.findTaskForTrigger(tid);
      if (prior) {
        const result = { taskId: prior.id, created: false };
        this.store.toolActions.recordOrGet({
          sessionId: input.sessionId,
          toolCallId: input.toolCallId,
          runId: input.runId,
          tool: "start_task",
          result,
        });
        return result;
      }
    }

    const def = this.store.catalog.getDefinition(input.definition);
    if (
      !def ||
      !this.store.catalog
        .listActiveDefinitions()
        .some((d) => d.id === input.definition)
    ) {
      throw new Error(
        `Unknown or inactive worker definition: ${input.definition}`,
      );
    }

    validateWorkerTools(def);

    const primaryTriggerId = input.triggerIds[0];
    if (!primaryTriggerId) {
      throw new Error("start_task requires at least one triggerId");
    }
    const primary = this.store.triggers.get(primaryTriggerId);
    if (!primary) throw new Error(`Trigger not found: ${primaryTriggerId}`);

    // Messages that arrived in one new conversation before its first Task was
    // created must not fork into duplicate Workers just because Router batched them.
    const conversation = primary.threadId
      ? this.store.tasks.findOpenByThread(primary.threadId)
      : [];
    const previous = conversation.length === 1 ? conversation[0] : undefined;
    if (previous && primary.createdAt <= previous.createdAt) {
      this.store.transaction(() => {
        for (const triggerId of input.triggerIds)
          this.store.inbox.insertOrGet({ target: previous.id, triggerId });
        this.store.toolActions.recordOrGet({
          sessionId: input.sessionId,
          toolCallId: input.toolCallId,
          runId: input.runId,
          tool: "start_task",
          result: { taskId: previous.id, created: false },
        });
      });
      return { taskId: previous.id, created: false };
    }

    const result = this.store.transaction(() => {
      const task = this.createTaskRecord({
        ownerId: input.ownerId ?? primary.actorId ?? "owner",
        objective: input.objective,
        definition: def,
        originTriggerId: primaryTriggerId,
      });

      if (primary.threadId) {
        this.store.tasks.addSubscription(task.id, primary.threadId);
      }

      for (const tid of input.triggerIds) {
        this.store.inbox.insertOrGet({ target: task.id, triggerId: tid });
      }

      return { taskId: task.id, created: true };
    });

    this.store.toolActions.recordOrGet({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      runId: input.runId,
      tool: "start_task",
      result,
    });
    return result;
  }

  sendToTask(input: {
    sessionId: string;
    toolCallId: string;
    runId: string;
    taskId: string;
    triggerIds: string[];
    steer?: boolean;
  }): { ok: boolean; reason?: string } {
    const existing = this.store.toolActions.get(
      input.sessionId,
      input.toolCallId,
    );
    if (existing) return existing.result as { ok: boolean; reason?: string };

    const task = this.store.tasks.get(input.taskId);
    if (!task || this.store.tasks.isTerminal(task.status)) {
      const result = { ok: false, reason: "task not open" };
      this.store.toolActions.recordOrGet({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        runId: input.runId,
        tool: "send_to_task",
        result,
      });
      return result;
    }

    this.store.transaction(() => {
      for (const tid of input.triggerIds) {
        this.store.inbox.insertOrGet({
          target: task.id,
          triggerId: tid,
          steer: input.steer,
        });
        const trigger = this.store.triggers.get(tid);
        if (trigger?.threadId)
          this.store.tasks.addSubscription(task.id, trigger.threadId);
      }
    });

    const result = { ok: true };
    this.store.toolActions.recordOrGet({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      runId: input.runId,
      tool: "send_to_task",
      result,
    });
    return result;
  }

  stopTask(input: {
    sessionId: string;
    toolCallId: string;
    runId: string;
    taskId: string;
  }): { ok: boolean } {
    const existing = this.store.toolActions.get(
      input.sessionId,
      input.toolCallId,
    );
    if (existing) return existing.result as { ok: boolean };

    const task = this.store.tasks.get(input.taskId);
    if (task && !this.store.tasks.isTerminal(task.status)) {
      const activeOp = this.store.operations.findActiveForTask(task.id);
      this.store.transaction(() => {
        this.store.tasks.transition(task.id, task.status, "cancelled");
        this.store.inbox.cancelPending(task.id);
        if (activeOp) {
          this.store.operations.finish(
            activeOp.id,
            ["pending", "running"],
            "cancelled",
            null,
          );
        }
      });
      this.onStop?.(task.id, activeOp?.id ?? null);
    }

    const result = { ok: true };
    this.store.toolActions.recordOrGet({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      runId: input.runId,
      tool: "stop_task",
      result,
    });
    return result;
  }

  reply(input: {
    sessionId: string;
    toolCallId: string;
    runId: string;
    triggerId: string;
    content: string;
  }): { deliveryId: string } {
    const existing = this.store.toolActions.get(
      input.sessionId,
      input.toolCallId,
    );
    if (existing) return existing.result as { deliveryId: string };

    const trigger = this.store.triggers.get(input.triggerId);
    if (!trigger) throw new Error(`Trigger not found: ${input.triggerId}`);

    const delivery = this.delivery.enqueue({
      channel: trigger.source === "console" ? "console" : trigger.source,
      target: trigger.threadId ?? trigger.id,
      content: input.content,
      idempotencyKey: `reply:${trigger.id}`,
    });

    const result = { deliveryId: delivery.id };
    this.store.toolActions.recordOrGet({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      runId: input.runId,
      tool: "reply",
      result,
    });
    return result;
  }

  private createTaskRecord(input: {
    ownerId: string;
    objective: string;
    definition: WorkerDefinitionSpec;
    originTriggerId: string;
  }): Task {
    // Pre-allocate workspace path using a temporary id pattern — TaskRepo generates id.
    const task = this.store.tasks.insert({
      ownerId: input.ownerId,
      objective: input.objective,
      definition: input.definition,
      originTriggerId: input.originTriggerId,
      workspacePath: "pending",
      status: "pending",
    });

    const workspacePath = this.workspaces.ensureTaskWorkspace(task.id);
    mkdirSync(this.paths.taskSkills(task.id), { recursive: true });
    snapshotSkillsForTask(
      this.store,
      input.definition.skills,
      this.paths.taskSkills(task.id),
    );

    this.store.db
      .prepare(
        "UPDATE tasks SET workspace_path = ?, updated_at = ? WHERE id = ?",
      )
      .run(workspacePath, nowIso(), task.id);

    // Ensure Pizza session row for the task
    const eventsPath = this.paths.sessionEvents(task.id, "main");
    mkdirSync(dirname(eventsPath), { recursive: true });
    this.store.sessions.ensure(task.id, eventsPath);

    return this.store.tasks.get(task.id)!;
  }

  private findTaskForTrigger(triggerId: string): Task | null {
    const row = this.store.db
      .prepare(
        `SELECT t.id FROM tasks t
         JOIN inbox i ON i.target = t.id
         WHERE i.trigger_id = ?
         LIMIT 1`,
      )
      .get(triggerId) as { id: string } | undefined;
    return row ? this.store.tasks.get(row.id) : null;
  }
}

import { mkdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import type { Store } from "../storage/index.js";
import type { DataPaths } from "../paths.js";
import type { SessionRow, Run, InboxItem } from "../types.js";
import { TaggingStore } from "./tagging-store.js";

/**
 * Pizza session execution boundary.
 */
export interface SessionFacadeHandle {
  session: SessionRow;
  tagging: TaggingStore | null;
  prompt(text: string): Promise<void>;
  abort(reason?: string): Promise<void>;
  close(): Promise<void>;
}

export type FacadeFactory = (input: {
  session: SessionRow;
  cwd?: string;
  systemPrompt?: string;
  model?: string;
}) => Promise<SessionFacadeHandle>;

export class SessionManager {
  private readonly facades = new Map<string, SessionFacadeHandle>();

  constructor(
    private readonly store: Store,
    private readonly paths: DataPaths,
    private readonly facadeFactory: FacadeFactory,
  ) {}

  ensureSession(owner: string): SessionRow {
    const eventsPath = this.paths.sessionEvents(owner, "main");
    mkdirSync(dirname(eventsPath), { recursive: true });
    return this.store.sessions.ensure(owner, eventsPath);
  }

  async open(
    owner: string,
    opts?: { cwd?: string; systemPrompt?: string; model?: string },
  ): Promise<SessionFacadeHandle> {
    const existing = this.facades.get(owner);
    if (existing) return existing;

    const session = this.ensureSession(owner);
    const handle = await this.facadeFactory({
      session,
      cwd: opts?.cwd,
      systemPrompt: opts?.systemPrompt,
      model: opts?.model,
    });
    this.facades.set(owner, handle);
    return handle;
  }

  get(owner: string): SessionFacadeHandle | undefined {
    return this.facades.get(owner);
  }

  isIdle(owner: string): boolean {
    const session = this.store.sessions.getByOwner(owner);
    if (!session) return true;
    return this.store.runs.findActive(session.id)?.status !== "submitted";
  }

  /**
   * Create a Run, bind pending inbox items, and build the prompt to submit.
   * Returns null if session busy or inbox empty.
   */
  beginRun(
    owner: string,
    formatPrompt: (items: InboxItem[]) => string,
  ): { run: Run; items: InboxItem[]; promptText: string } | null {
    if (!this.isIdle(owner)) return null;
    const session = this.ensureSession(owner);
    return this.store.transaction(() => {
      // Re-check single-writer inside tx
      const existing = this.store.runs.findActive(session.id);
      if (existing?.status === "submitted") return null;
      if (existing?.status === "pending") {
        const items = this.store.inbox.listAccepted(existing.id);
        if (!items.length) return null;
        return { run: existing, items, promptText: formatPrompt(items) };
      }
      const pending = this.store.inbox.listPending(owner);
      if (pending.length === 0) return null;

      const run = this.store.runs.create(session.id);
      this.store.inbox.bindToRun(
        pending.map((i) => i.id),
        run.id,
      );
      const promptText = formatPrompt(pending);
      return { run, items: pending, promptText };
    });
  }

  async recoverIncomplete(): Promise<number> {
    const incomplete = this.store.runs.listIncomplete();
    for (const run of incomplete) {
      const session = this.store.sessions.get(run.sessionId)!;
      const receipt = readPizzaReceipt(session, run.id);
      this.store.transaction(() => {
        const accepted = this.store.inbox
          .listAccepted(run.id)
          .map((item) => item.id);
        const task =
          session.owner === "router"
            ? null
            : this.store.tasks.get(session.owner);
        if (receipt?.completed) {
          this.store.runs.transition(
            run.id,
            run.status,
            receipt.failed
              ? "failed"
              : receipt.aborted
                ? "aborted"
                : "completed",
          );
          this.store.inbox.markDone(accepted);
        } else if (
          !receipt &&
          accepted.length &&
          (!task || !this.store.tasks.isTerminal(task.status))
        ) {
          // Submission never reached Pizza. Reuse the same Run and bound inputs.
          this.store.runs.transition(run.id, run.status, "pending");
        } else {
          this.store.runs.transition(run.id, run.status, "failed");
          this.store.inbox.markDone(accepted);
          if (receipt && (!task || !this.store.tasks.isTerminal(task.status))) {
            const actions = this.store.db
              .prepare(
                "SELECT tool, result FROM tool_actions WHERE run_id = ? ORDER BY created_at",
              )
              .all(run.id);
            const externalId = `run-recovery:${run.id}`;
            const trigger =
              this.store.triggers.findByExternal("system", externalId) ??
              this.store.triggers.insert({
                source: "system",
                externalId,
                threadId: null,
                actorId: "system",
                payloadRef: `run:${run.id}`,
                preview: `Resume interrupted Run ${run.id}. Original inputs and tool results are in the session history. Inspect workspace and current Tasks before continuing; do not repeat committed side effects. Committed application actions: ${JSON.stringify(actions)}.`,
                status: "routed",
              });
            this.store.inbox.insertOrGet({
              target: session.owner,
              triggerId: trigger.id,
            });
          }
        }
      });
    }
    return incomplete.length;
  }

  async closeAll(): Promise<void> {
    for (const handle of this.facades.values()) {
      await handle.close();
    }
    this.facades.clear();
  }
}

/** Read the immutable receipt before SDK startup compensation can alter the log. */
function readPizzaReceipt(
  session: SessionRow,
  runId: string,
): { completed: boolean; aborted: boolean; failed: boolean } | null {
  if (!existsSync(session.eventsPath)) return null;
  const db = new DatabaseSync(session.eventsPath, { readOnly: true });
  try {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'",
        )
        .get()
    )
      return null;
    const receipt = db
      .prepare(
        "SELECT sequence FROM events WHERE type='USER_MESSAGE' AND thread_id=? AND idempotency_key=?",
      )
      .get(session.id, `run:${runId}`);
    if (!receipt) return null;
    const completion = db
      .prepare(
        "SELECT sequence,payload_json FROM events WHERE type='AGENT_TURN_COMPLETED' AND thread_id=? AND sequence>? ORDER BY sequence LIMIT 1",
      )
      .get(session.id, receipt.sequence!);
    const reason = completion
      ? JSON.parse(String(completion.payload_json)).reason
      : undefined;
    const lastMessage = completion
      ? db
          .prepare(
            "SELECT payload_json FROM events WHERE type='AGENT_MESSAGE_END' AND thread_id=? AND sequence>? AND sequence<? ORDER BY sequence DESC LIMIT 1",
          )
          .get(session.id, receipt.sequence!, completion.sequence!)
      : null;
    const stop = lastMessage
      ? JSON.parse(String(lastMessage.payload_json)).stop_reason
      : undefined;
    return {
      completed: !!completion,
      failed:
        ["error", "loop_detected"].includes(reason) ||
        ["error", "length"].includes(stop),
      aborted: reason === "aborted",
    };
  } finally {
    db.close();
  }
}

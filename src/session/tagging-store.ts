/**
 * Tagging store wrapper for the Pizza SessionEventStore.
 *
 * Marks the first USER_MESSAGE of a prompt with idempotency_key = `run:<runId>`.
 * The narrow store interface isolates the wrapper from SDK storage internals.
 */

export interface EventAppendInput {
  type: string;
  idempotency_key?: string | null;
  [key: string]: unknown;
}

export interface SessionEventStoreLike {
  append(e: EventAppendInput): unknown;
  appendBatch?(events: EventAppendInput[]): unknown;
}

export class TaggingStore {
  pendingRunId: string | undefined;

  constructor(private readonly inner: SessionEventStoreLike) {}

  beginRun(runId: string): void {
    this.pendingRunId = runId;
  }

  append(e: EventAppendInput): unknown {
    return this.inner.append(this.maybeTag(e));
  }

  appendBatch(events: EventAppendInput[]): unknown {
    if (!this.inner.appendBatch) {
      return events.map((e) => this.append(e));
    }
    return this.inner.appendBatch(events.map((e) => this.maybeTag(e)));
  }

  private maybeTag(e: EventAppendInput): EventAppendInput {
    if (e.type === "USER_MESSAGE" && this.pendingRunId) {
      const tagged = {
        ...e,
        idempotency_key: `run:${this.pendingRunId}`,
      };
      this.pendingRunId = undefined;
      return tagged;
    }
    return e;
  }
}

import type { Ingress } from "../ingress/index.js";
import type { IngressResult } from "../ingress/index.js";
import { newId } from "../ids.js";

/** Turn Console writes into console-sourced Triggers via Ingress. */
export class ConsoleChannelIngress {
  constructor(private readonly ingress: Ingress) {}

  submit(input: {
    text: string;
    actorId?: string;
    taskId?: string | null;
    threadId?: string | null;
    steer?: boolean;
    stopTaskId?: string;
  }): IngressResult {
    // New console requests get a fresh thread so they hit Router,
    // instead of colliding with a prior Task's subscription on a shared thread.
    // Follow-ups that set taskId keep that task's identity as thread.
    const threadId =
      input.threadId ??
      (input.taskId
        ? `console:task:${input.taskId}`
        : `console:${newId("th")}`);

    return this.ingress.accept({
      source: "console",
      externalId: `console:${newId("msg")}`,
      threadId,
      actorId: input.actorId ?? "owner",
      preview: input.text.slice(0, 200),
      payload: {
        text: input.text,
        steer: !!input.steer,
      },
      taskId: input.taskId,
      steer: input.steer,
      control: input.stopTaskId
        ? { kind: "stop", taskId: input.stopTaskId }
        : null,
    });
  }
}

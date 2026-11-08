/** Shared domain types. All of these are persisted in state.sqlite. */

export type TriggerStatus = "pending" | "routed" | "ignored";
export type TaskStatus =
  | "pending"
  | "active"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
export type RunStatus =
  | "pending"
  | "submitted"
  | "completed"
  | "aborted"
  | "failed";
export type InboxStatus = "pending" | "accepted" | "done" | "cancelled";
export type OperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";
export type DeliveryStatus =
  | "sending"
  | "pending"
  | "sent"
  | "failed"
  | "unknown";
export type SubmitOutcome = "completed" | "failed" | "needs_input";

export type SourceKind = "console" | "feishu" | "github" | "webhook" | "system";

export interface WorkerDefinitionSpec {
  id: string;
  description: string;
  systemPrompt: string;
  model: string;
  /** Allowed native CLI commands; cli and task commands are always registered. */
  tools: string[];
  /** Policy for Pizza's native CLI; underscore commands share one tool. */
  cli?: { allowShell: boolean };
  skills: string[];
}

export interface Trigger {
  id: string;
  source: SourceKind | string;
  externalId: string;
  threadId: string | null;
  actorId: string | null;
  payloadRef: string;
  preview: string;
  status: TriggerStatus;
  createdAt: string;
}

export interface Task {
  id: string;
  ownerId: string;
  objective: string;
  definition: WorkerDefinitionSpec;
  originTriggerId: string;
  workspacePath: string;
  branch: string | null;
  status: TaskStatus;
  result: TaskResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  outcome: SubmitOutcome;
  notice: string;
  summary: string;
  artifacts?: string[];
}

export interface SessionRow {
  id: string;
  owner: string; // 'router' | task_id
  eventsPath: string;
  createdAt: string;
}

export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface InboxItem {
  id: string;
  target: string; // 'router' | task_id
  triggerId: string;
  steer: boolean;
  status: InboxStatus;
  runId: string | null;
  createdAt: string;
}

export interface ToolAction {
  sessionId: string;
  toolCallId: string;
  runId: string;
  tool: string;
  result: unknown;
  createdAt: string;
}

export interface Operation {
  id: string;
  taskId: string;
  cmd: string;
  status: OperationStatus;
  pgid: number | null;
  procStartTime: string | null;
  deadlineAt: string | null;
  logPath: string | null;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Delivery {
  id: string;
  idempotencyKey: string;
  channel: string;
  target: string;
  content: string;
  status: DeliveryStatus;
  externalMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillMeta {
  name: string;
  description: string;
  updatedAt: string;
}

export interface SkillFile {
  skillName: string;
  path: string;
  content: Buffer;
  mode: number;
}

export interface IngressInput {
  source: SourceKind | string;
  externalId: string;
  threadId?: string | null;
  actorId?: string | null;
  preview: string;
  /** Full payload written under blobs/; stored as payload_ref. */
  payload: unknown;
  /** Console may target a specific task. */
  taskId?: string | null;
  steer?: boolean;
  /** Control command, e.g. stop. */
  control?: { kind: "stop"; taskId: string } | null;
}

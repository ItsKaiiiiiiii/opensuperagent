import { join } from "node:path";

/** Data directory layout: everything OpenSuperAgent persists lives under this root. */
export class DataPaths {
  constructor(readonly root: string) {}

  get stateDb(): string {
    return join(this.root, "state.sqlite");
  }

  get instanceLock(): string {
    return join(this.root, "instance.lock");
  }

  get blobs(): string {
    return join(this.root, "blobs");
  }

  get repos(): string {
    return join(this.root, "repos");
  }

  get workspaces(): string {
    return join(this.root, "workspaces");
  }

  get tasks(): string {
    return join(this.root, "tasks");
  }

  get operations(): string {
    return join(this.root, "operations");
  }

  get sessions(): string {
    return join(this.root, "sessions");
  }

  sessionEvents(owner: string, sessionId: string): string {
    return join(this.root, "sessions", owner, sessionId, "events.sqlite");
  }

  workspace(taskId: string): string {
    return join(this.root, "workspaces", taskId);
  }

  taskSkills(taskId: string): string {
    return join(this.root, "tasks", taskId, "skills");
  }

  operationDir(operationId: string): string {
    return join(this.root, "operations", operationId);
  }

  blob(ref: string): string {
    return join(this.root, "blobs", ref);
  }
}

export const DATA_SUBDIRS = [
  "blobs",
  "repos",
  "workspaces",
  "tasks",
  "operations",
  "sessions",
] as const;

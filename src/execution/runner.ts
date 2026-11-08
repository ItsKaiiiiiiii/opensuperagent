import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  openSync,
  closeSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Store } from "../storage/index.js";
import type { DataPaths } from "../paths.js";
import type { AppConfig } from "../config.js";
import type { Operation } from "../types.js";
import { nowIso } from "../ids.js";

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

/**
 * Command executor.
 * Writes the Operation row first, then starts the process; result.json finalizes status.
 */
export class CommandRunner {
  private readonly children = new Map<string, ChildProcess>();

  constructor(
    private readonly store: Store,
    private readonly paths: DataPaths,
    private readonly config: AppConfig,
  ) {}

  assertIdle(taskId: string): Operation | null {
    return this.store.operations.findActiveForTask(taskId);
  }

  startBackground(input: {
    taskId: string;
    cmd: string;
    cwd: string;
    deadlineAt?: string | null;
  }): Operation {
    if (
      input.deadlineAt != null &&
      (!Number.isFinite(Date.parse(input.deadlineAt)) ||
        Date.parse(input.deadlineAt) <= Date.now())
    )
      throw new Error(
        "deadlineAt must be a valid future timestamp; omit it to use the default deadline",
      );
    const busy = this.assertIdle(input.taskId);
    if (busy) throw new BusyError(busy.id);

    const op = this.store.transaction(() => {
      const created = this.store.operations.insert({
        taskId: input.taskId,
        cmd: input.cmd,
        deadlineAt:
          input.deadlineAt ??
          new Date(
            Date.now() + this.config.execution.default_deadline_sec * 1000,
          ).toISOString(),
      });
      const dir = this.paths.operationDir(created.id);
      mkdirSync(dir, { recursive: true });
      const logPath = join(dir, "output.log");
      this.store.operations.markRunning(created.id, -1, nowIso(), logPath);
      return this.store.operations.get(created.id)!;
    });

    this.spawnDetached(op, input.cwd);
    return this.store.operations.get(op.id)!;
  }

  async execSync(input: {
    taskId: string;
    cmd: string;
    cwd: string;
    timeoutSec?: number;
  }): Promise<{ operation: Operation; result: CommandResult; log: string }> {
    const busy = this.assertIdle(input.taskId);
    if (busy) throw new BusyError(busy.id);

    const timeout = input.timeoutSec ?? this.config.execution.exec_timeout_sec;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error("timeoutSec must be a positive finite number");
    if (timeout > this.config.execution.exec_timeout_sec) {
      throw new Error(
        `timeout ${timeout}s exceeds exec_timeout_sec ${this.config.execution.exec_timeout_sec}`,
      );
    }

    const op = this.store.transaction(() => {
      const created = this.store.operations.insert({
        taskId: input.taskId,
        cmd: input.cmd,
        deadlineAt: new Date(Date.now() + timeout * 1000).toISOString(),
      });
      const dir = this.paths.operationDir(created.id);
      mkdirSync(dir, { recursive: true });
      const logPath = join(dir, "output.log");
      this.store.operations.markRunning(created.id, -1, nowIso(), logPath);
      return this.store.operations.get(created.id)!;
    });

    const result = await this.runForeground(op, input.cwd, timeout);
    this.finalizeFromResult(op.id);
    const fresh = this.store.operations.get(op.id)!;
    const log =
      fresh.logPath && existsSync(fresh.logPath)
        ? readFileSync(fresh.logPath, "utf8")
        : "";
    return { operation: fresh, result, log };
  }

  stop(operationId: string): void {
    const child = this.children.get(operationId);
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5_000).unref();
    }

    this.store.operations.finish(
      operationId,
      ["pending", "running"],
      "cancelled",
      null,
    );
  }

  recoverIncomplete(): number {
    let n = 0;
    for (const op of this.store.operations.listIncomplete()) {
      const resultPath = join(this.paths.operationDir(op.id), "result.json");
      if (existsSync(resultPath)) {
        this.finalizeFromResult(op.id);
      } else {
        this.store.operations.finish(
          op.id,
          ["pending", "running"],
          "unknown",
          null,
        );
      }
      n += 1;
    }
    return n;
  }

  poll(): string[] {
    const completed: string[] = [];
    for (const op of this.store.operations.listIncomplete()) {
      if (op.status !== "running") continue;
      const resultPath = join(this.paths.operationDir(op.id), "result.json");
      if (existsSync(resultPath)) {
        this.finalizeFromResult(op.id);
        completed.push(op.id);
        continue;
      }
      if (op.deadlineAt && Date.now() > Date.parse(op.deadlineAt)) {
        this.stop(op.id);
        completed.push(op.id);
      }
    }
    return completed;
  }

  private spawnDetached(op: Operation, cwd: string): void {
    const dir = this.paths.operationDir(op.id);
    const logPath = join(dir, "output.log");
    const resultPath = join(dir, "result.json");
    const logFd = openSync(logPath, "a");

    const child = spawn("/bin/sh", ["-c", op.cmd], {
      cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: scrubEnv(),
    });
    closeSync(logFd);

    if (child.pid) {
      this.store.db
        .prepare("UPDATE operations SET pgid = ?, updated_at = ? WHERE id = ?")
        .run(child.pid, nowIso(), op.id);
    }

    this.children.set(op.id, child);
    child.once("error", (error) => appendFileSync(logPath, `${error}\n`));

    child.once("close", (code, signal) => {
      this.children.delete(op.id);
      atomicWriteResult(resultPath, {
        exitCode: code,
        signal,
        finishedAt: nowIso(),
      });
    });
  }

  private runForeground(
    op: Operation,
    cwd: string,
    timeoutSec: number,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const dir = this.paths.operationDir(op.id);
      const logPath = join(dir, "output.log");
      const resultPath = join(dir, "result.json");
      const logFd = openSync(logPath, "a");

      const child = spawn("/bin/sh", ["-c", op.cmd], {
        cwd,
        stdio: ["ignore", logFd, logFd],
        env: scrubEnv(),
      });
      closeSync(logFd);
      this.children.set(op.id, child);
      child.once("error", (error) => appendFileSync(logPath, `${error}\n`));

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, timeoutSec * 1000);

      child.once("close", (code, signal) => {
        clearTimeout(timer);
        this.children.delete(op.id);
        const result: CommandResult = {
          exitCode: code,
          signal,
          timedOut,
        };
        atomicWriteResult(resultPath, {
          ...result,
          finishedAt: nowIso(),
        });
        resolve(result);
      });
    });
  }

  private finalizeFromResult(operationId: string): void {
    const resultPath = join(
      this.paths.operationDir(operationId),
      "result.json",
    );
    if (!existsSync(resultPath)) return;
    const raw = JSON.parse(readFileSync(resultPath, "utf8")) as {
      exitCode: number | null;
      signal?: string | null;
      timedOut?: boolean;
    };
    let status: "succeeded" | "failed" | "cancelled" = "succeeded";
    if (raw.timedOut) status = "failed";
    else if (raw.exitCode === null) status = "cancelled";
    else if (raw.exitCode !== 0) status = "failed";

    this.store.operations.finish(
      operationId,
      ["pending", "running"],
      status,
      raw.exitCode,
    );
  }
}

export class BusyError extends Error {
  constructor(readonly operationId: string) {
    super(`Task busy with operation ${operationId}`);
    this.name = "BusyError";
  }
}

function scrubEnv(): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TERM",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) {
    if (process.env[k]) env[k] = process.env[k];
  }
  for (const k of Object.keys(process.env)) {
    if (/^(NODE_|NPM_|PNPM_|YARN_|CARGO_|RUSTUP_|GO|JAVA_HOME|DENO_)/.test(k)) {
      env[k] = process.env[k];
    }
  }
  return env;
}

function atomicWriteResult(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

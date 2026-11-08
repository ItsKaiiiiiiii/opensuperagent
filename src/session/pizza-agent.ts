import { mkdirSync } from "node:fs";
import type { ToolDefinition } from "@tomsun28/pizza";
import type { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import type { Store } from "../storage/index.js";
import type { DataPaths } from "../paths.js";
import type { RouterTools } from "../router/tools.js";
import type { WorkerControls } from "../worker/controls.js";
import type { EventBus } from "../events/bus.js";
import type { LlmConfig } from "../llm/types.js";
import type { FacadeFactory, SessionFacadeHandle } from "./manager.js";
import { TaggingStore, type EventAppendInput } from "./tagging-store.js";
import { ROUTER_CHAT_TOOLS, executeRouterTool } from "../llm/tools-router.js";
import { submitResultCommand } from "../worker/commands.js";
import { validateToolArguments } from "../llm/tool-validation.js";
import { nativeWorkerTools } from "./native-worker-tools.js";

type Pizza = typeof import("@tomsun28/pizza");
let sdk: Promise<Pizza> | undefined;
function loadPizza() {
  return (sdk ??= import("@tomsun28/pizza"));
}
export async function ensurePizzaRuntime(): Promise<void> {
  await loadPizza();
}

type EventQuery = {
  after_sequence?: number;
  thread_id?: string;
  types?: string[];
  reverse?: boolean;
  limit?: number;
};

/** Duck-typed surface of pizza's SqliteEventStore (not exported at package root). */
type EventStoreLike = {
  append(e: EventAppendInput): unknown;
  appendBatch?(e: EventAppendInput[]): unknown;
  query?(
    filter: EventQuery,
  ): { payload?: unknown; idempotency_key?: string; sequence: number }[];
  flush?(): Promise<void>;
  head_sequence?: number;
  [key: string]: unknown;
};

const ROUTER_MAX_CALLS = 16;
const WORKER_MAX_CALLS = 40;

// Pizza 0.5.1 releases its advisory lock file but leaves its four process
// listeners registered. Remove those exact callbacks when the facade closes.
// Serialize setup so concurrent sessions cannot capture each other's hooks.
let sessionSetup: Promise<unknown> = Promise.resolve();
function createSessionWithCleanup(
  pizza: Pizza,
  options: Parameters<Pizza["createSessionFacade"]>[0],
) {
  const setup = sessionSetup.then(async () => {
    const processHooks: EventEmitter = process;
    const signals = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
    const before = new Map(
      signals.map((signal) => [
        signal,
        new Set(processHooks.listeners(signal)),
      ]),
    );
    const added = () =>
      signals.flatMap((signal) =>
        processHooks
          .listeners(signal)
          .filter(
            (listener) =>
              !before.get(signal)!.has(listener) &&
              ["onSignal", "onExit"].includes(listener.name) &&
              /release\(\)/.test(String(listener)),
          )
          .map((listener) => ({ signal, listener })),
      );
    try {
      const created = await pizza.createSessionFacade(options);
      const hooks = added();
      created.facade.addDisposer(() => {
        for (const { signal, listener } of hooks)
          processHooks.removeListener(
            signal,
            listener as (...args: unknown[]) => void,
          );
      });
      return created;
    } catch (error) {
      for (const { signal, listener } of added())
        processHooks.removeListener(
          signal,
          listener as (...args: unknown[]) => void,
        );
      throw error;
    }
  });
  sessionSetup = setup.catch(() => undefined);
  return setup;
}

/**
 * Pizza-backed session facade: the durable event log at
 * sessions/<owner>/<id>/events.sqlite gives runs resumable context, and
 * TaggingStore marks each run's first USER_MESSAGE for replay dedup.
 */
export function createPizzaFacadeFactory(deps: {
  store: Store;
  paths: DataPaths;
  routerTools: RouterTools;
  workerControls: WorkerControls;
  events: EventBus;
  resolveModel: (owner: "router" | "worker", profile?: string) => LlmConfig;
  routerSystemPrompt?: () => string;
  redact?: (message: string) => string;
}): FacadeFactory {
  return async ({ session, cwd, systemPrompt, model: modelName }) => {
    const pizza = await loadPizza();
    const owner = session.owner;
    const isRouter = owner === "router";
    const task = isRouter ? null : deps.store.tasks.get(owner);
    if (!isRouter && !task) {
      throw new Error(`Worker session ${owner} has no task`);
    }

    const agentDir = join(dirname(session.eventsPath), "agent");
    mkdirSync(agentDir, { recursive: true });
    const auth = pizza.AuthStorage.inMemory();
    const registry = pizza.ModelRegistry.inMemory(auth);
    const resolveModel = () => {
      const cfg = deps.resolveModel(
        isRouter ? "router" : "worker",
        modelName,
      );
      const modelId = isRouter ? cfg.routerModel : cfg.workerModel;
      registry.registerProvider(cfg.provider, {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        api:
          cfg.protocol === "anthropic"
            ? "anthropic-messages"
            : "openai-completions",
        models: [
          {
            id: modelId,
            name: modelId,
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: cfg.maxTokens ?? 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      auth.setRuntimeApiKey(cfg.provider, cfg.apiKey || "unused");
      const model = registry.find(cfg.provider, modelId);
      if (!model)
        throw new Error(`Model ${cfg.provider}/${modelId} unavailable`);
      return model;
    };
    const model = resolveModel();
    const redact = (message: string) => deps.redact?.(message) ?? message;
    const chatTools = isRouter ? ROUTER_CHAT_TOOLS : [];

    let activeRunId = "";
    let yielded = false;
    let toolTail: Promise<unknown> = Promise.resolve();
    let facade: Awaited<ReturnType<Pizza["createSessionFacade"]>>["facade"];
    const controlTools: ToolDefinition[] = chatTools.map((tool) => ({
      name: tool.function.name,
      label: tool.function.name,
      description: tool.function.description ?? "",
      parameters: pizza.Type.Unsafe(tool.function.parameters),
      async execute(toolCallId, params) {
        const args = (params ?? {}) as Record<string, unknown>;
        const result = await executeRouterTool({
          tools: deps.routerTools,
          store: deps.store,
          sessionId: session.id,
          runId: activeRunId,
          toolCallId,
          name: tool.function.name,
          args,
        });
        return {
          details: { result },
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
        };
      },
    }));
    const nativeTools = isRouter ? [] : nativeWorkerTools(
      pizza, task!.definition, cwd ?? task!.workspacePath, deps.paths.taskSkills(owner),
      [submitResultCommand({
        controls: deps.workerControls,
        taskId: owner,
        sessionId: session.id,
        runId: () => activeRunId,
        sourceInfo: pizza.createSyntheticSourceInfo("<opensuperagent:task>", { source: "sdk" }),
      })],
    );
    const customTools: ToolDefinition[] = [...nativeTools, ...controlTools].map((tool) => ({
      ...tool,
      execute: (...args) => {
        const runId = activeRunId;
        // Serialize tool batches within a Run; implementation and result format
        // for CLI/file/skill operations belong entirely to Pizza.
        const execution = toolTail.then(async () => {
          args[2]?.throwIfAborted();
          if (runId !== activeRunId) throw new Error("Tool belongs to an earlier Run");
          if (!runId || deps.store.runs.get(runId)?.status !== "submitted")
            throw new Error("Run is no longer active");
          if (!isRouter && deps.store.tasks.isTerminal(deps.store.tasks.get(owner)!.status))
            throw new Error("Task is closed");
          const invalid = validateToolArguments(args[1], tool.parameters);
          if (invalid) throw new Error(`Invalid tool arguments: ${invalid}`);
          const result = await tool.execute(...args);
          const builtin = (result.details as {
            builtin?: { name?: string; details?: { result?: { ok?: boolean } } };
          } | undefined)?.builtin;
          const submitted = builtin?.name === "_submit_result" && builtin.details?.result?.ok;
          if (!isRouter && (submitted || deps.store.tasks.isTerminal(deps.store.tasks.get(owner)!.status))) {
            yielded = true;
            facade.abort();
          }
          if (!yielded && llmCalls >= maxCalls) {
            overBudget = true;
            facade.abort();
          }
          return result;
        });
        toolTail = execution.catch(() => undefined);
        return execution;
      },
    }));

    const created = await createSessionWithCleanup(pizza, {
      cwd: cwd ?? deps.paths.root,
      agentDir,
      storagePath: session.eventsPath,
      workspaceId: "opensuperagent",
      threadId: session.id,
      authStorage: auth,
      modelRegistry: registry,
      settingsManager: pizza.SettingsManager.inMemory({}),
      resourceLoaderOptions: {
        systemPrompt: systemPrompt ?? "",
        noExtensions: true,
        noBuiltinExtensions: true,
        noSkills: true,
        skillsOverride: () => isRouter
          ? { skills: [], diagnostics: [] }
          : pizza.loadSkillsFromDir({ dir: deps.paths.taskSkills(owner), source: "task" }),
        noBuiltinSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
      model,
      thinkingLevel: "off",
      tools: customTools.map((tool) => tool.name),
      customTools,
      safeModeDefault: false,
      approvalUi: false,
      isMainAgent: false,
    });
    facade = created.facade;
    const eventStore = created.runtime.store as unknown as EventStoreLike;

    // Route appends through TaggingStore so each run's first USER_MESSAGE
    // carries idempotency_key = run:<runId>. SqliteEventStore is not exported
    // by the package, so the proxy is applied onto the live instance.
    const tagging = new TaggingStore({
      append: eventStore.append.bind(eventStore),
      appendBatch: eventStore.appendBatch?.bind(eventStore),
    });
    try {
      eventStore.append = (e: EventAppendInput) => tagging.append(e);
      if (typeof eventStore.appendBatch === "function")
        eventStore.appendBatch = (es: EventAppendInput[]) =>
          tagging.appendBatch(es);
    } catch (error) {
      await facade.disposeAsync();
      throw new Error("Pizza event store cannot be tagged", { cause: error });
    }

    let aborted = false;
    let llmCalls = 0;
    let overBudget = false;
    const maxCalls = isRouter ? ROUTER_MAX_CALLS : WORKER_MAX_CALLS;

    facade.subscribe((event) => {
      const payload =
        (event as { payload?: Record<string, unknown> }).payload ?? {};
      switch (event.type) {
        case "LLM_CALL_REQUESTED":
          if (++llmCalls > maxCalls) {
            overBudget = true;
            queueMicrotask(() => facade.abort());
          }
          break;
        case "AGENT_MESSAGE_END": {
          const text = contentText(payload.content);
          if (text)
            deps.events.emit({
              scope: owner,
              kind: "assistant",
              summary: text.slice(0, 240),
            });
          break;
        }
        case "TOOL_EXECUTION_START":
          deps.events.emit({
            scope: owner,
            kind: "tool",
            summary: String(payload.tool_name ?? "tool"),
            payload: {
              runId: activeRunId,
              toolCallId: payload.tool_call_id,
              args: payload.arguments,
            },
          });
          break;
        case "TOOL_EXECUTION_END":
          deps.events.emit({
            scope: owner,
            kind: "tool_result",
            summary: `${String(payload.tool_name ?? "tool")} → ${redact(summarize(toolResult(payload)))}`,
            payload: {
              runId: activeRunId,
              toolCallId: payload.tool_call_id,
              isError: !!payload.is_error,
              details: payload.details,
              result: toolResult(payload),
            },
          });
          break;
        case "AGENT_ERROR":
          deps.events.emit({
            scope: owner,
            kind: "error",
            summary: redact(String(payload.error ?? "agent error")),
          });
          break;
      }
    });

    const lastMessageEnd = (afterSequence: number) =>
      eventStore.query?.({
        after_sequence: afterSequence,
        thread_id: session.id,
        types: ["AGENT_MESSAGE_END"],
        reverse: true,
        limit: 1,
      })?.[0];

    const handle: SessionFacadeHandle = {
      session,
      tagging,
      async prompt(text) {
        const active = deps.store.runs.findActive(session.id);
        if (!active) return;
        aborted = false;
        yielded = false;
        llmCalls = 0;
        overBudget = false;
        // Snapshot credentials and model once per Run, including reused sessions.
        facade.setModel(resolveModel(), "off");
        if (isRouter && deps.routerSystemPrompt)
          facade.systemPrompt = deps.routerSystemPrompt();
        activeRunId = active.id;
        tagging.beginRun(active.id);
        deps.events.emit({
          scope: owner,
          kind: "prompt",
          summary: text.slice(0, 200),
          payload: { runId: active.id, model: modelName },
        });
        const startSequence = eventStore.head_sequence ?? 0;
        try {
          await facade.prompt(text);
          const messages = eventStore.query?.({
            types: ["USER_MESSAGE"],
            thread_id: session.id,
            after_sequence: startSequence,
          });
          if (
            messages?.length !== 1 ||
            messages[0]?.idempotency_key !== `run:${active.id}` ||
            tagging.pendingRunId
          )
            throw new Error(
              "Pizza Run has no unique durable submission receipt",
            );
          await eventStore.flush?.();
          if (overBudget)
            throw new Error(`Model call budget exceeded (${maxCalls})`);
          const payload = (lastMessageEnd(startSequence)?.payload ?? {}) as {
            stop_reason?: string;
            error_message?: string;
          };
          if (
            !yielded &&
            !aborted &&
            payload.stop_reason &&
            payload.stop_reason !== "stop" &&
            payload.stop_reason !== "aborted"
          )
            throw new Error(
              stopReasonMessage(payload.stop_reason, payload.error_message),
            );
        } catch (err) {
          deps.store.runs.transition(
            active.id,
            "submitted",
            aborted ? "aborted" : "failed",
          );
          deps.events.emit({
            scope: owner,
            kind: "error",
            summary: redact(String(err)),
          });
          throw err;
        } finally {
          const run = deps.store.runs.get(active.id);
          if (run?.status === "submitted" && aborted)
            deps.store.runs.transition(active.id, "submitted", "aborted");
          if (run?.status === "submitted" && !aborted) {
            deps.store.runs.transition(active.id, "submitted", "completed");
          }
          deps.events.emit({
            scope: owner,
            kind: thisRunStatus(deps.store.runs.get(active.id)?.status),
            summary: `Run ${active.id} ${deps.store.runs.get(active.id)?.status ?? "ended"}`,
            payload: { runId: active.id },
          });
        }
      },
      async abort(reason) {
        aborted = true;
        facade.abort();
        const active = deps.store.runs.findActive(session.id);
        if (active)
          deps.store.runs.transition(
            active.id,
            active.status as "pending" | "submitted",
            "aborted",
          );
        deps.events.emit({
          scope: owner,
          kind: "aborted",
          summary: reason ?? "aborted",
        });
      },
      async close() {
        facade.abort();
        await facade.disposeAsync();
      },
    };
    return handle;
  };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: string; text?: string } =>
        !!c && c.type === "text" && typeof c.text === "string",
    )
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();
}

function summarize(value: unknown): string {
  try {
    const s = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return String(value);
  }
}

function stopReasonMessage(stop: string, message?: string): string {
  if (stop === "length") {
    return "Response exceeded the length limit; narrow the task scope.";
  }
  const code = message?.match(/^(\d{3}):/)?.[1];
  if (code === "401" || code === "403") return "Model auth failed (401/403)";
  if (code === "402") return "Model provider balance insufficient (402)";
  if (code === "429") return "Model rate limited (429)";
  if (code && Number(code) >= 500)
    return `Model provider unavailable (${code})`;
  return message ?? `Agent turn ended without completing (${stop})`;
}

function thisRunStatus(status?: string): string {
  return status === "completed"
    ? "run_completed"
    : status === "aborted"
      ? "aborted"
      : "run_failed";
}

function toolResult(payload: Record<string, unknown>): unknown {
  const details = payload.details as {
    result?: unknown;
    builtin?: { details?: { result?: unknown } };
  } | undefined;
  return details?.result ?? details?.builtin?.details?.result ?? payload.result;
}

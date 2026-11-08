import { t as tr, useLocale } from "../i18n";
import { sourceName, sourceStatus, shortId, time } from "../lib/presentation";
import { useEffect, useState } from "react";
import {
  ArrowRightIcon,
  ArrowClockwiseIcon,
  ArrowUpRightIcon,
  BooksIcon,
  CodeIcon,
  GitBranchIcon,
  RobotIcon,
  PaperPlaneTiltIcon,
  StopIcon,
  TerminalWindowIcon,
  LightningIcon,
  CheckCircleIcon,
} from "@phosphor-icons/react";
import { api, type Overview, type SkillDetail, type TaskFlow } from "../api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { EmptyState, SourceIcon, Status, EventFeed } from "./shared";
export type Selection = {
  kind: "task" | "worker" | "skill" | "source";
  id: string;
} | null;
export function DetailPanel({
  selection,
  onClose,
  data,
  onSelect,
  onRefresh,
  notify,
}: {
  selection: Selection;
  onClose: () => void;
  data: Overview;
  onSelect: (selection: Selection) => void;
  onRefresh: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  useLocale();
  const [flow, setFlow] = useState<TaskFlow | null>(null);
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("flow");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState("SKILL.md");
  useEffect(() => {
    if (!selection || !["task", "skill"].includes(selection.kind)) return;
    let disposed = false;
    const load = async () => {
      try {
        if (selection.kind === "task") {
          const result = await api.flow(selection.id);
          if (!disposed) {
            setFlow(result);
            setError("");
          }
        } else {
          const result = await api.skill(selection.id);
          if (!disposed) {
            setSkill(result);
            setError("");
          }
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    };
    void load();
    const timer =
      selection.kind === "task"
        ? setInterval(() => void load(), 4000)
        : undefined;
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [selection, data.generatedAt]);
  async function act(kind: "message" | "steer" | "stop") {
    if (!selection || busy) return;
    setBusy(true);
    try {
      if (kind === "stop") await api.stop(selection.id);
      else await api.message(selection.id, text.trim(), kind === "steer");
      setText("");
      notify(
        kind === "stop"
          ? tr("details.stopRequested")
          : kind === "steer"
            ? tr("details.steerSent")
            : tr("details.messageSent"),
      );
      const result = await api.flow(selection.id);
      setFlow(result);
      onRefresh();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setBusy(false);
    }
  }
  const worker =
    selection?.kind === "worker"
      ? data.definitions.find((w) => w.id === selection.id)
      : null;
  const source =
    selection?.kind === "source"
      ? data.sources.find((s) => s.id === selection.id)
      : null;
  const title =
    selection?.kind === "task"
      ? tr("details.taskTitle")
      : selection?.kind === "worker"
        ? tr("common.workerDefinition")
        : selection?.kind === "skill"
          ? tr("details.skillTitle")
          : tr("common.messageChannel");
  const task = flow?.task;
  const terminal =
    task && ["completed", "failed", "cancelled"].includes(task.status);
  const loadedSkills = flow?.journal.flatMap((event) => {
    // Journal events may carry a null payload (e.g. "assistant" entries);
    // keep the render resilient instead of crashing the whole panel.
    const payload = (event.payload ?? {}) as {
      isError?: boolean;
      args?: { action?: string; name?: string; path?: string };
      details?: { builtin?: { name?: string; args?: { action?: string; name?: string; file?: string } } };
    };
    const builtin = payload.details?.builtin;
    if (event.kind === "tool_result" && builtin?.name === "skill" && !payload.isError &&
        ["load", "read"].includes(builtin.args?.action ?? "")) {
      return [{ event, name: builtin.args?.name, path: builtin.args?.file }];
    }
    // Keep historical journal entries visible after upgrading the tool surface.
    if (event.kind === "tool" && event.summary === "skill" && payload.args?.action !== "list") {
      return [{ event, name: payload.args?.name, path: payload.args?.path }];
    }
    return [];
  }) ?? [];

  return (
    <Dialog
      open={!!selection}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="detail-panel">
        <DialogHeader className="detail-header">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{selection?.id}</DialogDescription>
        </DialogHeader>
        <div className="detail-scroll">
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {selection?.kind === "task" && !flow && !error && (
            <div className="loading-state">{tr("details.loadingFlow")}</div>
          )}
          {task && selection?.kind === "task" && (
            <>
              <div className="detail-task-title">
                <Status status={task.status} />
                <h2>{task.objective}</h2>
                <div className="inline-meta">
                  <SourceIcon source={flow.origin?.source ?? "console"} />
                  {sourceName(flow.origin?.source ?? "console")}
                  <span>·</span>
                  <RobotIcon />
                  {task.definition.id}
                  <span>·</span>
                  {flow.runs.length}
                  {" "}{tr("common.count.runs")}{" "}
                </div>
              </div>
              <div className="tab-bar">
                <button
                  className={tab === "flow" ? "active" : ""}
                  onClick={() => setTab("flow")}
                >
                  {tr("details.tabFlow")}{" "}
                </button>
                <button
                  className={tab === "log" ? "active" : ""}
                  onClick={() => setTab("log")}
                >
                  {tr("details.tabLog")}{" "}
                  <span>{flow.journal.length}</span>
                </button>
                <button
                  className={tab === "context" ? "active" : ""}
                  onClick={() => setTab("context")}
                >
                  {tr("details.tabContext")}{" "}
                </button>
              </div>
              {tab === "flow" && (
                <div className="run-flow">
                  <div className="trace-step">
                    <div className="trace-icon">
                      <SourceIcon source={flow.origin?.source ?? "console"} />
                    </div>
                    <div>
                      <h3>
                        {tr("details.requestReceived")}{" "}
                        <time>{time(task.createdAt)}</time>
                      </h3>
                      <p>{flow.origin?.preview ?? task.objective}</p>
                      <small>{flow.origin?.threadId ?? tr("details.noThread")}</small>
                    </div>
                  </div>
                  <div className="trace-step">
                    <div className="trace-icon orange">R</div>
                    <div>
                      <h3>{tr("details.routerAssigned")}</h3>
                      <p>
                        {tr("details.choose")}{" "}
                        <b>{task.definition.id}</b>
                        {tr("details.assignTail")}{" "}
                        {task.definition.skills.length}
                        {" "}{tr("details.countSkills")}{" "}
                      </p>
                      {flow.routerRuns.map((run) => (
                        <code key={run.id}>
                          {shortId(run.id)} ·{" "}
                          {run.actions.map((a) => a.tool).join(" → ")}
                        </code>
                      ))}
                    </div>
                  </div>
                  <div className="trace-step">
                    <div className="trace-icon gold">
                      <BooksIcon />
                    </div>
                    <div>
                      <h3>
                        {tr("details.skillSnapshot")}{" "}
                        <span>{task.definition.skills.length}</span>
                      </h3>
                      <div className="tag-list">
                        {task.definition.skills.map((name) => (
                          <span className="tag" key={name}>
                            {name}
                          </span>
                        ))}
                      </div>
                      <small>
                        {tr("details.skillNote")}{" "}
                      </small>
                    </div>
                  </div>
                  {flow.runs.map((run, index) => (
                    <div className="trace-step" key={run.id}>
                      <div className="trace-icon teal">
                        <ArrowClockwiseIcon />
                      </div>
                      <div className="run-card">
                        <h3>
                          {tr("details.workerRound")}{" "}
                          {index + 1}
                          {" "}{tr("details.roundSuffix")}{" "}
                          <span className="tag">
                            {run.status === "completed"
                              ? tr("details.roundDone")
                              : run.status === "submitted"
                                ? tr("status.active")
                                : run.status}
                          </span>
                        </h3>
                        <small>
                          {time(run.createdAt)} → {time(run.updatedAt)}
                        </small>
                        {run.inputs.map((input) => (
                          <div key={input.id} className="run-input">
                            <SourceIcon source={input.source} size={14} />
                            <span>{input.preview}</span>
                            {!!input.steer && (
                              <span className="tag">steer</span>
                            )}
                          </div>
                        ))}
                        <div className="tool-chain">
                          {run.actions.map((a) => (
                            <span key={a.toolCallId}>
                              <CodeIcon size={13} />
                              {a.tool}
                            </span>
                          ))}
                          {!run.actions.length && (
                            <small>
                              {tr("details.actionsNote")}
                            </small>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {!!loadedSkills.length && (
                    <div className="trace-step">
                      <div className="trace-icon gold">
                        <BooksIcon />
                      </div>
                      <div>
                        <h3>{tr("details.skillLoads")}</h3>
                        {loadedSkills.map(({ event, name, path }) => (
                          <p key={event.id}>
                            <code>{name ?? "skill"} / {path ?? "SKILL.md"}</code>{" "}
                            <small>{time(event.createdAt)}</small>
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                  {flow.operations.map((op) => (
                    <div className="trace-step" key={op.id}>
                      <div className="trace-icon">
                        <TerminalWindowIcon />
                      </div>
                      <div>
                        <h3>
                          {tr("details.command")}{" "}
                          <span className="tag">{op.status}</span>
                        </h3>
                        <pre>{op.cmd}</pre>
                        <small>
                          exit {op.exitCode ?? tr("details.noResult")}
                          {" "}{tr("details.commandWake")}{" "}
                        </small>
                      </div>
                    </div>
                  ))}
                  {task.result && (
                    <div className="trace-step">
                      <div className="trace-icon teal">
                        <CheckCircleIcon />
                      </div>
                      <div>
                        <h3>{tr("details.workerResult")}</h3>
                        <p className="preserve-lines">{task.result.summary}</p>
                        {task.result.artifacts?.map((artifact) => (
                          <code key={artifact} className="artifact">
                            {artifact}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}
                  {flow.deliveries.map((d) => (
                    <div className="trace-step" key={d.id}>
                      <div className="trace-icon">
                        <PaperPlaneTiltIcon />
                      </div>
                      <div>
                        <h3>
                          Delivery → {sourceName(d.channel) ?? d.channel}{" "}
                          <span className="tag">
                            {(
                              {
                                sent: tr("details.delivered"),
                                pending: tr("details.delivering"),
                                sending: tr("details.sending"),
                                failed: tr("details.deliveryFailed"),
                                unknown: tr("details.deliveryUnknown"),
                              } as Record<string, string>
                            )[d.status] ?? d.status}
                          </span>
                        </h3>
                        <p className="preserve-lines">{d.content}</p>
                        <small>{d.target}</small>
                        {d.status === "unknown" && (
                          <div className="delivery-confirm">
                            <p>
                              {tr("details.deliveryUnknownNote")}{" "}
                            </p>
                            <div>
                              {(
                                [
                                  ["sent", tr("details.confirmDelivered")],
                                  ["failed", tr("details.confirmFailed")],
                                ] as const
                              ).map(([status, label]) => (
                                <Button
                                  key={status}
                                  variant="outline"
                                  disabled={busy}
                                  onClick={async () => {
                                    setBusy(true);
                                    try {
                                      await api.resolveDelivery(d.id, status);
                                      if (selection)
                                        setFlow(await api.flow(selection.id));
                                      notify(tr("details.deliveryConfirmed"));
                                      onRefresh();
                                    } catch (e) {
                                      notify(String(e), true);
                                    } finally {
                                      setBusy(false);
                                    }
                                  }}
                                >
                                  {label}
                                </Button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {!flow.runs.length && (
                    <p className="muted">{tr("details.noRuns")}</p>
                  )}
                </div>
              )}
              {tab === "log" && (
                <EventFeed
                  events={flow.journal}
                  onTask={(id) => onSelect({ kind: "task", id })}
                />
              )}
              {tab === "context" && (
                <div className="context-panel">
                  <h3>{tr("details.workspace")}</h3>
                  <pre>{task.workspacePath}</pre>
                  <p>
                    <GitBranchIcon /> {task.branch ?? tr("details.ownDirectory")}
                  </p>
                  <h3>{tr("details.threads")}</h3>
                  {flow.subscriptions.map((s) => (
                    <code className="artifact" key={s.threadId}>
                      {s.threadId}
                    </code>
                  ))}
                  <h3>{tr("details.snapshotTitle")}</h3>
                  <p className="muted">
                    {tr("details.snapshotNote")}{" "}
                  </p>
                  <pre>{JSON.stringify(task.definition, null, 2)}</pre>
                </div>
              )}
            </>
          )}
          {selection?.kind === "worker" && worker && (
            <>
              <div className="object-intro">
                <span className="object-icon teal">
                  <RobotIcon size={27} />
                </span>
                <h2>{worker.id}</h2>
                <p>{tr(worker.description)}</p>
              </div>
              <div className="definition-spec">
                <div>
                  <span>{tr("common.model")}</span>
                  <b>{worker.model}</b>
                </div>
              </div>
              <h3 className="detail-section-heading">{tr("details.toolPerms")}</h3>
              <div className="tag-list">
                {worker.tools.map((tool) => (
                  <span className="tag" key={tool}>
                    {tool}
                  </span>
                ))}
              </div>
              <h3 className="detail-section-heading">
                {tr("details.referencedSkills")}{" "}
                <span>{worker.skills.length}</span>
              </h3>
              <p className="muted">
                {tr("details.skillsNote")}{" "}
              </p>
              {worker.skills.map((name) => (
                <button
                  key={name}
                  className="linked-row"
                  onClick={() => onSelect({ kind: "skill", id: name })}
                >
                  <BooksIcon />
                  <span>{name}</span>
                  <ArrowUpRightIcon />
                </button>
              ))}
              <h3 className="detail-section-heading">System Prompt</h3>
              <pre className="prompt-block">{worker.systemPrompt}</pre>
              <h3 className="detail-section-heading">{tr("details.relatedTasks")}</h3>
              {data.tasks
                .filter((t) => t.definition.id === worker.id)
                .map((t) => (
                  <button
                    key={t.id}
                    className="linked-row"
                    onClick={() => onSelect({ kind: "task", id: t.id })}
                  >
                    <span className="truncate">{t.objective}</span>
                    <Status status={t.status} />
                    <ArrowRightIcon />
                  </button>
                ))}
            </>
          )}
          {selection?.kind === "worker" && !worker && (
            <EmptyState title={tr("details.workerGone")}>
              {tr("details.workerGoneNote")}{" "}
            </EmptyState>
          )}
          {selection?.kind === "skill" && !skill && !error && (
            <div className="loading-state">{tr("details.loadingSkill")}</div>
          )}
          {selection?.kind === "skill" && skill && (
            <>
              <div className="object-intro">
                <span className="object-icon gold">
                  <BooksIcon size={27} />
                </span>
                <h2>{skill.name}</h2>
                <p>{tr(skill.description)}</p>
                <small>
                  {tr("details.updatedAt")}{" "}
                  {time(skill.updatedAt, true)}
                </small>
              </div>
              <h3 className="detail-section-heading">
                {tr("details.usedBy")}
              </h3>
              <div className="tag-list">
                {data.definitions
                  .filter((d) => d.skills.includes(skill.name))
                  .map((d) => (
                    <button
                      className="tag clickable"
                      key={d.id}
                      onClick={() => onSelect({ kind: "worker", id: d.id })}
                    >
                      <RobotIcon size={14} />
                      {d.id}
                      <ArrowUpRightIcon size={12} />
                    </button>
                  ))}
              </div>
              <h3 className="detail-section-heading">
                {tr("details.skillFiles")}{" "}
                <span>{skill.files.length}</span>
              </h3>
              <div className="file-tabs">
                {skill.files.map((f) => (
                  <button
                    className={file === f.path ? "active" : ""}
                    onClick={() => setFile(f.path)}
                    key={f.path}
                  >
                    {f.path}
                  </button>
                ))}
              </div>
              <pre className="skill-content">
                {skill.files.find((f) => f.path === file)?.content ??
                  skill.files[0]?.content ??
                  tr("details.noFiles")}
              </pre>
              {skill.files.find((f) => f.path === file)?.truncated && (
                <p className="muted">{tr("details.fileTruncated")}</p>
              )}
            </>
          )}
          {source && (
            <>
              <div className="object-intro">
                <span className={`object-icon source-${source.id}`}>
                  <SourceIcon source={source.id} size={27} />
                </span>
                <h2>{sourceName(source.id) ?? source.id}</h2>
                <p>
                  {source.id === "console"
                    ? tr("details.consoleDesc")
                    : tr(
                        "details.sourceDesc",
                      )}
                </p>
              </div>
              <div className="definition-spec">
                <div>
                  <span>{tr("details.transport")}</span>
                  <b>{sourceStatus(source)}</b>
                </div>
                <div>
                  <span>{tr("details.allowlist")}</span>
                  <b>{source.configured ? tr("common.configured") : tr("common.notConfigured")}</b>
                </div>
                <div>
                  <span>{tr("details.persisted")}</span>
                  <b>{source.count}</b>
                </div>
              </div>
              <h3 className="detail-section-heading">{tr("details.routingRules")}</h3>
              <div className="routing-rules">
                <p>
                  <span>01</span>
                  {tr("details.ruleOwned")} <ArrowRightIcon size={14} />
                  {" "}{tr("details.ruleToWorker")}{" "}
                </p>
                <p>
                  <span>02</span>
                  {tr("details.ruleNew")}{" "}
                  <ArrowRightIcon size={14} /> {tr("details.ruleRouter")}{" "}
                </p>
                <p>
                  <span>03</span>
                  {tr("details.workerResult")}{" "}
                  <ArrowRightIcon size={14} /> {tr("details.ruleDelivery")}{" "}
                </p>
              </div>
              {source.transport !== "available" && (
                <div className="integration-note">
                  <h3>{tr("details.status")}</h3>
                  <a href="#system" onClick={onClose} className="settings-jump">
                    {tr("details.toSettings")}{" "}
                    <ArrowUpRightIcon size={13} />
                  </a>
                  <p>
                    {sourceName(source.id)}{" "}
                    {tr("details.adapterNote")}{" "}
                  </p>
                  <p>
                    {tr("details.adapterEnabledNote")}{" "}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        {task && selection?.kind === "task" && (
          <div className="detail-composer">
            {terminal ? (
              <div className="terminal-note">
                <CheckCircleIcon size={18} />
                {tr("details.terminated")}{" "}
                <Button
                  variant="outline"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.createTask(
                        tr("details.continueTask", {
                          v0: task.id,
                          v1: task.objective,
                        }),
                      );
                      notify(tr("details.continueSent"));
                      onRefresh();
                      onClose();
                    } catch (e) {
                      notify(String(e), true);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  {tr("details.continueGoal")}{" "}
                  <ArrowUpRightIcon />
                </Button>
              </div>
            ) : (
              <>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={tr("details.composerPlaceholder")}
                  aria-label={tr("details.composerAria")}
                />
                <div className="composer-actions">
                  <Button
                    variant="ghost"
                    className="danger-button"
                    disabled={busy}
                    onClick={() => void act("stop")}
                  >
                    <StopIcon />
                    {tr("details.stopTask")}{" "}
                  </Button>
                  <div>
                    <Button
                      variant="outline"
                      disabled={busy || !text.trim()}
                      onClick={() => void act("steer")}
                    >
                      <LightningIcon />
                      {tr("details.steer")}{" "}
                    </Button>
                    <Button
                      disabled={busy || !text.trim()}
                      onClick={() => void act("message")}
                    >
                      <PaperPlaneTiltIcon />
                      {tr("details.send")}{" "}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

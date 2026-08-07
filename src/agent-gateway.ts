import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import type { RecoveryConfig } from "./config.js";
import { validateAgentResponse, type AgentResponse, type PendingOperation, type RecoveryState } from "./contracts.js";
import type { GitRepository } from "./git-repository.js";
import { redact } from "./redaction.js";
import type { StateStore } from "./state-store.js";
export const CODEX_SDK_VERSION = "0.147.0" as const;
export const MAX_AGENT_THREAD_TURNS = 8;
export const CODEX_CONFIG_OVERRIDES = { mcp_servers: {}, plugins: {}, allow_login_shell: false, shell_environment_policy: { inherit: "core", ignore_default_excludes: false }, features: { apps: false, goals: false, hooks: false, memories: false, multi_agent: false, network_proxy: false, remote_plugin: false, skill_mcp_dependency_install: false } } as const;
export const AGENT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "nextHint", "blocker"],
  properties: {
    outcome: { type: "string", enum: ["changed", "no_change", "goal_complete", "blocked"] },
    summary: { type: "string", minLength: 1 },
    nextHint: { type: ["string", "null"] },
    blocker: { type: ["string", "null"] },
  },
} as const;
export type AgentMode = "work" | "recovery";
export type ThreadRotationReason =
  | "no-thread" | "forced" | "hard-rollback" | "agent-history-violation"
  | "repair-attempt-limit" | "turn-limit" | "resume-failed";
export interface AgentUsage {
  inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number;
  outputTokens: number; reasoningTokens: number;
}
export interface RecoveryEvidence {
  checkId: string; failingCommand: readonly string[]; normalizedOutcome: string;
  stdoutPath: string; stderrPath: string; firstBadCommit: string | null;
  regressionWindow: readonly [string, string] | null;
  firstBadDiff: string | null; previousRepairSummaries: readonly string[];
  fallbackAfterTurn: string;
}
export interface ThreadBoundaryInput {
  hardRollback?: boolean; agentHistoryViolation?: boolean;
  repairAttempts?: number; force?: boolean;
}
export interface ThreadDecision {
  action: "start" | "resume"; reason: ThreadRotationReason | null; rotated: boolean;
}
export interface AgentInvocation {
  store: StateStore; repository: GitRepository; config: RecoveryConfig;
  unitId: string; mode: AgentMode; recovery?: RecoveryEvidence;
  threadBoundaries?: ThreadBoundaryInput; signal?: AbortSignal;
}
export interface AgentTurnResult {
  response: AgentResponse; threadId: string; usage: AgentUsage | null;
  turnId: string; logDirectory: string; resumed: boolean;
  fallbackToFreshThread: boolean;
}
export interface AgentGateway {
  invoke(request: AgentInvocation): Promise<AgentTurnResult>;
}
export interface CodexThreadOptions {
  model: string; modelReasoningEffort: RecoveryConfig["agent"]["reasoningEffort"];
  workingDirectory: string; sandboxMode: "workspace-write";
  networkAccessEnabled: false; webSearchMode: "disabled"; webSearchEnabled: false;
  approvalPolicy: "never"; skipGitRepoCheck: false; additionalDirectories: string[];
}
export interface CodexSdkThread {
  readonly id: string | null;
  runStreamed(prompt: string, options: { outputSchema: unknown; signal: AbortSignal }): Promise<{ events: AsyncIterable<unknown> }>;
}
export interface CodexSdkClient {
  startThread(options: CodexThreadOptions): CodexSdkThread; resumeThread(id: string, options: CodexThreadOptions): CodexSdkThread;
}
export class AgentTimeoutError extends Error {
  constructor(seconds: number) { super(`coding-agent turn timed out after ${seconds}s`); this.name = "AgentTimeoutError"; }
}
export class AgentCancelledError extends Error {
  constructor() { super("coding-agent turn was cancelled"); this.name = "AgentCancelledError"; }
}
export class AgentResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "AgentResponseError"; }
}
export function decideThreadAction(state: Pick<RecoveryState["agent"], "threadId" | "threadTurns">, boundaries: ThreadBoundaryInput, maxRepairTurns: number): ThreadDecision {
  const reason = boundaries.force === true ? "forced" : boundaries.hardRollback === true ? "hard-rollback"
    : boundaries.agentHistoryViolation === true ? "agent-history-violation"
        : boundaries.repairAttempts !== undefined && boundaries.repairAttempts >= maxRepairTurns
          ? "repair-attempt-limit" : state.threadTurns >= MAX_AGENT_THREAD_TURNS ? "turn-limit" : null;
  if (state.threadId === null) return { action: "start", reason: reason ?? "no-thread", rotated: false };
  return reason === null
    ? { action: "resume", reason: null, rotated: false }
    : { action: "start", reason, rotated: true };
}
export class CodexAgentGateway implements AgentGateway {
  readonly #sdk: CodexSdkClient;
  constructor(sdk?: CodexSdkClient) {
    if (sdk !== undefined) { this.#sdk = sdk; return; }
    const codex = new Codex({ config: CODEX_CONFIG_OVERRIDES });
    this.#sdk = { startThread: (options) => codex.startThread(options),
      resumeThread: (id, options) => codex.resumeThread(id, options) };
  }
  async invoke(request: AgentInvocation): Promise<AgentTurnResult> {
    assertModeEvidence(request);
    const state = await request.store.readState();
    if (state.phase !== "idle") throw new Error(`agent invocation requires idle state, found ${state.phase}`);
    if (request.config.agent.networkAccess) throw new Error("agent network access must be disabled");
    if (!pathsEqual(state.repository.worktreePath, request.repository.repositoryRoot)) throw new Error("agent repository is not the durable autonomous worktree");
    const head = await request.repository.assertBranchIdentity(request.config.branch);
    if (head !== state.repository.expectedHead) throw new Error("agent invocation head differs from durable state");
    const decision = decideThreadAction(state.agent, request.threadBoundaries ?? {}, request.config.limits.maxRepairTurnsPerFailure);
    const layout = await request.store.ensureSessionLayout(state.session.id);
    const turnId = `${String(state.agent.turns + 1).padStart(5, "0")}-${safeSegment(request.unitId)}-${randomUUID().slice(0, 8)}`;
    const logDirectory = path.join(layout.agent, turnId);
    await mkdir(logDirectory);
    const invocationPath = path.join(logDirectory, "invocation.json");
    const eventsPath = path.join(logDirectory, "events.jsonl"); const finalPath = path.join(logDirectory, "final-response.json");
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const metadata: Record<string, unknown> = {
      sdk: { package: "@openai/codex-sdk", version: CODEX_SDK_VERSION },
      status: "running", unitId: request.unitId, mode: request.mode,
      requestedModel: request.config.agent.model,
      requestedEffort: request.config.agent.reasoningEffort,
      requestedThreadId: state.agent.threadId, threadAction: decision.action,
      rotationReason: decision.reason, workingDirectory: state.repository.worktreePath,
      sandboxMode: "workspace-write", approvalPolicy: "never", networkAccess: false,
      webSearch: "disabled", timeoutSeconds: request.config.limits.agentTurnSeconds,
      startedAt,
    };
    await writeJson(invocationPath, metadata);
    await writeFile(eventsPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });

    if (decision.rotated && decision.reason !== null) await recordRotation(request.store, head, decision.reason, state.agent.threadId);
    const operation = agentOperation(request, head, startedAt);
    await request.store.persistIntent(request.mode === "work" ? "agent-running" : "repairing", operation);
    await request.store.appendEvent({ type: "agent-started", headCommit: head,
      data: { unitId: request.unitId, mode: request.mode, turnId, threadAction: decision.action } });
    const abort = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const cancel = (): void => { cancelled = true; abort.abort(request.signal?.reason); };
    if (request.signal?.aborted === true) cancel();
    else request.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, request.config.limits.agentTurnSeconds * 1_000);
    timer.unref();

    let threadId: string | null = decision.action === "resume" ? state.agent.threadId : null;
    let usage: AgentUsage | null = null; let fallback = false;
    let startedFresh = decision.action === "start";
    try {
      const options = threadOptions(request.config, state.repository.worktreePath);
      let prompt = await buildPrompt(request, decision.action === "start" ? decision.reason : null);
      let attempt: AttemptResult;
      if (decision.action === "resume" && state.agent.threadId !== null) {
        try {
          attempt = await runAttempt(this.#sdk.resumeThread(state.agent.threadId, options), prompt, abort.signal, eventsPath, 1, request.store);
        } catch (error) {
          const failure = asAttemptFailure(error);
          if (timedOut || cancelled || failure.turnStarted) throw failure;
          fallback = true;
          startedFresh = true;
          await appendAgentLog(eventsPath, { attempt: 1, event: { type: "gateway.resume_failed", message: errorMessage(failure) } });
          await recordRotation(request.store, head, "resume-failed", state.agent.threadId);
          prompt = await buildPrompt(request, "resume-failed");
          attempt = await runAttempt(this.#sdk.startThread(options), prompt, abort.signal, eventsPath, 2, request.store);
        }
      } else {
        attempt = await runAttempt(this.#sdk.startThread(options), prompt, abort.signal, eventsPath, 1, request.store);
      }
      threadId = attempt.threadId; usage = attempt.usage;
      const response = parseResponse(attempt.finalResponse);
      await writeJson(finalPath, sanitizeAgentResponse(response));
      await settleState(request.store, head, operation.id, threadId, usage, startedFresh, true);
      Object.assign(metadata, finishMetadata(started, "completed", threadId, usage, fallback, null));
      await writeJson(invocationPath, metadata);
      await request.store.appendEvent({ type: "agent-completed", headCommit: head,
        data: { unitId: request.unitId, mode: request.mode, turnId, threadId,
          outcome: response.outcome, durationMs: Date.now() - started, usage } });
      return { response, threadId, usage, turnId, logDirectory,
        resumed: decision.action === "resume" && !fallback, fallbackToFreshThread: fallback };
    } catch (error) {
      abort.abort(error);
      const failure = timedOut ? new AgentTimeoutError(request.config.limits.agentTurnSeconds)
        : cancelled ? new AgentCancelledError() : error instanceof Error ? error : new Error(String(error));
      if (error instanceof AttemptFailure) { threadId = error.threadId; usage = error.usage; }
      await settleState(request.store, head, operation.id, threadId, usage, startedFresh, false);
      Object.assign(metadata, finishMetadata(started, timedOut ? "timed_out" : cancelled ? "cancelled" : "failed", threadId, usage, fallback, failure));
      await writeJson(invocationPath, metadata);
      await request.store.appendEvent({ type: "agent-failed", headCommit: head,
        data: { unitId: request.unitId, mode: request.mode, turnId,
          durationMs: Date.now() - started, timedOut, cancelled, error: scrub(failure.message) } });
      throw failure;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
    }
  }
}
interface AttemptResult { threadId: string; finalResponse: string; usage: AgentUsage | null }
class AttemptFailure extends Error {
  constructor(cause: unknown, readonly turnStarted: boolean, readonly threadId: string | null, readonly usage: AgentUsage | null) {
    super(errorMessage(cause), { cause }); this.name = "AttemptFailure";
  }
}
async function runAttempt(thread: CodexSdkThread, prompt: string, signal: AbortSignal, eventsPath: string, attempt: number, store: StateStore): Promise<AttemptResult> {
  let threadId = thread.id; let finalResponse = ""; let usage: AgentUsage | null = null;
  let turnStarted = false; let completed = false;
  try {
    const stream = await raceAbort(thread.runStreamed(prompt, { outputSchema: AGENT_RESPONSE_SCHEMA, signal }), signal);
    const iterator = stream.events[Symbol.asyncIterator]();
    while (true) {
      const next = await raceAbort(iterator.next(), signal);
      if (next.done === true) break;
      const event = expectRecord(next.value, "SDK event");
      await appendAgentLog(eventsPath, { attempt, event });
      if (event.type === "thread.started") {
        threadId = expectText(event.thread_id, "thread.started.thread_id");
        await store.update((draft) => { draft.agent.threadId = threadId; });
      } else if (event.type === "turn.started") turnStarted = true;
      else if (event.type === "turn.completed") { usage = parseUsage(event.usage); completed = true; }
      else if (event.type === "turn.failed" || event.type === "error") throw new Error(eventMessage(event));
      else if (event.type === "item.completed") {
        const item = expectRecord(event.item, "item.completed.item");
        if (item.type === "agent_message") finalResponse = expectText(item.text, "agent message");
      }
    }
    if (!completed) throw new Error("SDK event stream ended without turn.completed");
    if (threadId === null) throw new Error("SDK event stream did not provide a thread ID");
    if (finalResponse.length === 0) throw new AgentResponseError("agent returned no final response");
    return { threadId, finalResponse, usage };
  } catch (error) { throw new AttemptFailure(error, turnStarted, threadId, usage); }
}
async function buildPrompt(request: AgentInvocation, freshReason: ThreadRotationReason | null): Promise<string> {
  const state = await request.store.readState();
  const goal = await readFile(path.join(state.repository.worktreePath, ...request.config.goalFile.split("/")), "utf8");
  const commits = (await request.repository.git(["log", "-8", "--format=%H%x09%s"])).stdout.trim();
  const events = (await request.store.readEvents()).events.slice(-8).map((event) => ({
    sequence: event.sequence, type: event.type, headCommit: event.headCommit, data: event.data,
  }));
  const context = {
    branch: state.repository.branch, currentHead: await request.repository.head(),
    knownGoodCommit: state.health.knownGoodCommit, lastSmokePassCommit: state.health.lastSmokePassCommit,
    lastDeepRunCommit: state.health.lastDeepRunCommit, pendingFailure: state.health.pendingFailure,
    abandonedRanges: state.recovery.abandonedRanges, recentCommits: commits || "(none)",
    recentEvents: events, remainingAgentTurns: Math.max(0, request.config.limits.maxAgentTurns - state.agent.turns),
    freshThreadReason: freshReason,
  };
  const mode = request.mode === "work"
    ? "Choose and implement one coherent next improvement toward the product goal. You select the work and implement it yourself; no other agent role is present."
    : `Repair the root cause of the exact observed failure below. Do not hide it by weakening checks.\nRecovery evidence:\n${JSON.stringify(request.recovery, null, 2)}`;
  return `You are the single Recovery Loop coding agent.\n\n${mode}\n\nProduct goal (operator-owned; do not edit):\n${goal}\n\nRepository and durable state context:\n${JSON.stringify(context, null, 2)}\n\nYou may inspect and edit source, tests, documentation, and local tooling inside this worktree. You may run useful local commands. Do not commit, reset, rebase, merge, revert, cherry-pick, create branches or tags, manipulate worktrees, modify .git or recovery runtime state, push, publish, deploy, contact external services, request credentials, edit RECOVERY_GOAL.md or .recovery-loop/config.json, or write outside this worktree. Network access is disabled. Make normal engineering decisions autonomously and stop after one checkpoint-sized outcome. The controller will own Git history, checkpoint edits before checks, and decide check success from command results; your prose is only an observation. Ordinary uncertainty is not a blocker. Use blocked only for credentials, unavailable required external services, contradictory authority, or destructive risk.\n\nReturn only the requested four-field structured response.`;
}
function threadOptions(config: RecoveryConfig, workingDirectory: string): CodexThreadOptions {
  return { model: config.agent.model, modelReasoningEffort: config.agent.reasoningEffort,
    workingDirectory, sandboxMode: "workspace-write", networkAccessEnabled: false,
    webSearchMode: "disabled", webSearchEnabled: false, approvalPolicy: "never",
    skipGitRepoCheck: false, additionalDirectories: [] };
}
async function recordRotation(store: StateStore, head: string, reason: ThreadRotationReason, oldThreadId: string | null): Promise<void> {
  await store.update((draft) => { draft.agent.threadId = null; draft.agent.threadTurns = 0; });
  await store.appendEvent({ type: "thread-rotated", headCommit: head, data: { reason, oldThreadId } });
}
async function settleState(store: StateStore, head: string, operationId: string, threadId: string | null, usage: AgentUsage | null, fresh: boolean, complete: boolean): Promise<void> {
  const apply = (draft: RecoveryState): void => {
    draft.agent.turns += 1; draft.agent.threadId = threadId;
    draft.agent.threadTurns = threadId === null ? 0 : fresh ? 1 : draft.agent.threadTurns + 1;
    draft.usage.agentTurns += 1;
    if (usage !== null) {
      draft.usage.inputTokens += usage.inputTokens; draft.usage.cachedInputTokens += usage.cachedInputTokens;
      draft.usage.outputTokens += usage.outputTokens; draft.usage.reasoningTokens += usage.reasoningTokens;
    }
  };
  if (complete) {
    if ((await store.readState()).operation?.id !== operationId) throw new Error("agent operation changed while settling");
    await store.finishOperation(head, apply);
  } else await store.update((draft) => {
      if (draft.operation?.id !== operationId) throw new Error("agent operation changed while settling");
      apply(draft);
    });
}
function parseResponse(text: string): AgentResponse {
  try { return validateAgentResponse(JSON.parse(text)); }
  catch (error) { throw new AgentResponseError(`invalid coding-agent final response: ${errorMessage(error)}`, { cause: error }); }
}
function parseUsage(value: unknown): AgentUsage {
  const usage = expectRecord(value, "turn.completed.usage");
  return { inputTokens: token(usage.input_tokens), cachedInputTokens: token(usage.cached_input_tokens),
    cacheWriteInputTokens: token(usage.cache_write_input_tokens), outputTokens: token(usage.output_tokens),
    reasoningTokens: token(usage.reasoning_output_tokens) };
}
function token(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("SDK usage contains an invalid token count");
  return value as number;
}
function agentOperation(request: AgentInvocation, head: string, startedAt: string): PendingOperation {
  return { id: `op-${randomUUID()}`, kind: "agent", unitId: request.unitId, baseCommit: head,
    targetCommit: null, observedHead: head, rescueRef: null, childPid: null,
    summary: `${request.mode} agent turn`, checkpointKind: null, startedAt };
}
function finishMetadata(started: number, status: string, threadId: string | null, usage: AgentUsage | null, fallback: boolean, error: Error | null): Record<string, unknown> {
  return { status, finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
    threadId, usage, fallbackToFreshThread: fallback, error: error === null ? null : scrub(error.message) };
}
async function appendAgentLog(file: string, value: unknown): Promise<void> {
  await appendFile(file, `${JSON.stringify(sanitizeLogValue(value))}\n`, { encoding: "utf8", mode: 0o600 });
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(sanitizeLogValue(value), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
function sanitizeLogValue(value: unknown, key = ""): unknown {
  if (/(?:^|_)(?:env|environment|token|secret|password|authorization|cookie|credential|api.?key)(?:$|_)/iu.test(key)) return "[REDACTED]";
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeLogValue(entry));
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [name, sanitizeLogValue(entry, name)]),
  );
  return value;
}
function sanitizeAgentResponse(response: AgentResponse): AgentResponse {
  return { outcome: response.outcome, summary: scrub(response.summary),
    nextHint: response.nextHint === null ? null : scrub(response.nextHint),
    blocker: response.blocker === null ? null : scrub(response.blocker) };
}
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { if (listener !== undefined) signal.removeEventListener("abort", listener); }
}
function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}
function expectText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is not a nonempty string`);
  return value;
}
function eventMessage(event: Record<string, unknown>): string {
  if (typeof event.message === "string") return event.message;
  const error = event.error; const message = error !== null && typeof error === "object"
    ? (error as Record<string, unknown>).message : null;
  return typeof message === "string" ? message : `SDK emitted ${String(event.type)}`;
}
function asAttemptFailure(error: unknown): AttemptFailure { return error instanceof AttemptFailure ? error : new AttemptFailure(error, false, null, null); }
function assertModeEvidence(request: AgentInvocation): void {
  if (request.mode === "recovery" && request.recovery === undefined) throw new Error("recovery mode requires failure evidence"); if (request.mode === "work" && request.recovery !== undefined) throw new Error("work mode must not include recovery evidence");
}
function safeSegment(value: string): string {
  const safe = value.replaceAll(/[^a-zA-Z0-9._-]+/gu, "-");
  if (safe.length === 0 || safe === "." || safe === "..") throw new Error("unsafe agent unit ID");
  return safe;
}
function pathsEqual(left: string, right: string): boolean { const a = path.resolve(left); const b = path.resolve(right); return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function scrub(text: string): string { return redact(text).replace(/((?:--?(?:api[-_]?key|token|secret|password)|authorization)(?:[=:]\s*|\s+))(?:"[^"]*"|'[^']*'|\S+)/giu, "$1[REDACTED]").replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL)[A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/gu, "$1=[REDACTED]"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

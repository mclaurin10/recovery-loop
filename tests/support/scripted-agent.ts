import type {
  AgentUsage,
  CodexSdkClient,
  CodexSdkThread,
  CodexThreadOptions,
} from "../../src/agent-gateway.js";

export interface ScriptedAgentActionContext {
  prompt: string;
  workingDirectory: string;
  signal: AbortSignal;
}

export interface ScriptedAgentStep {
  method: "start" | "resume";
  threadId?: string;
  response?: unknown;
  finalResponseText?: string;
  usage?: Partial<AgentUsage>;
  action?: (context: ScriptedAgentActionContext) => void | Promise<void>;
  errorBeforeTurn?: Error;
  errorAfterThreadStarted?: Error;
  waitForAbort?: boolean;
  extraEvents?: readonly unknown[];
  omitTurnCompleted?: boolean;
}

export interface ScriptedAgentCall {
  method: "start" | "resume";
  resumedThreadId: string | null;
  resultingThreadId: string;
  threadOptions: CodexThreadOptions;
  prompt: string | null;
  outputSchema: unknown;
}

const DEFAULT_USAGE: AgentUsage = {
  inputTokens: 10,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 1,
  outputTokens: 4,
  reasoningTokens: 3,
};

export class ScriptedAgentSdk implements CodexSdkClient {
  readonly calls: ScriptedAgentCall[] = [];
  readonly #steps: ScriptedAgentStep[];
  #sequence = 0;

  constructor(steps: readonly ScriptedAgentStep[]) {
    this.#steps = [...steps];
  }

  startThread(options: CodexThreadOptions): CodexSdkThread {
    return this.#thread("start", null, options);
  }

  resumeThread(id: string, options: CodexThreadOptions): CodexSdkThread {
    return this.#thread("resume", id, options);
  }

  assertFinished(): void {
    if (this.#steps.length > 0) throw new Error(`${this.#steps.length} scripted agent step(s) unused`);
  }

  #thread(
    method: "start" | "resume",
    resumedThreadId: string | null,
    threadOptions: CodexThreadOptions,
  ): CodexSdkThread {
    const step = this.#steps.shift();
    if (step === undefined) throw new Error(`unexpected ${method}Thread call`);
    if (step.method !== method) throw new Error(`expected ${step.method}Thread, received ${method}Thread`);
    this.#sequence += 1;
    const resultingThreadId = step.threadId ?? resumedThreadId ?? `scripted-thread-${this.#sequence}`;
    const call: ScriptedAgentCall = {
      method,
      resumedThreadId,
      resultingThreadId,
      threadOptions: structuredClone(threadOptions),
      prompt: null,
      outputSchema: null,
    };
    this.calls.push(call);
    return {
      id: resumedThreadId,
      runStreamed: async (prompt, options) => {
        call.prompt = prompt;
        call.outputSchema = structuredClone(options.outputSchema);
        return {
          events: scriptedEvents(step, resultingThreadId, prompt, threadOptions, options.signal),
        };
      },
    };
  }
}

async function* scriptedEvents(
  step: ScriptedAgentStep,
  threadId: string,
  prompt: string,
  threadOptions: CodexThreadOptions,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  if (step.errorBeforeTurn !== undefined) throw step.errorBeforeTurn;
  yield { type: "thread.started", thread_id: threadId };
  if (step.errorAfterThreadStarted !== undefined) throw step.errorAfterThreadStarted;
  yield { type: "turn.started" };
  await step.action?.({ prompt, workingDirectory: threadOptions.workingDirectory, signal });
  for (const event of step.extraEvents ?? []) yield event;
  if (step.waitForAbort === true) await waitForCancellation(signal);
  const responseText = step.finalResponseText ?? JSON.stringify(step.response ?? {
    outcome: "no_change",
    summary: "scripted no-change turn",
    nextHint: null,
    blocker: null,
  });
  yield {
    type: "item.completed",
    item: { id: `message-${threadId}`, type: "agent_message", text: responseText },
  };
  if (step.omitTurnCompleted !== true) {
    const usage = { ...DEFAULT_USAGE, ...step.usage };
    yield {
      type: "turn.completed",
      usage: {
        input_tokens: usage.inputTokens,
        cached_input_tokens: usage.cachedInputTokens,
        cache_write_input_tokens: usage.cacheWriteInputTokens,
        output_tokens: usage.outputTokens,
        reasoning_output_tokens: usage.reasoningTokens,
      },
    };
  }
}

function waitForCancellation(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

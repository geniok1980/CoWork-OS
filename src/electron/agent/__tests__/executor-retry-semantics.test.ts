import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

function createRetryExecutor(overrides?: {
  successCriteria?: Any;
  agentConfig?: Any;
  maxAttempts?: number;
}) {
  const executor = Object.create(TaskExecutor.prototype) as Any;

  executor.task = {
    id: "task-retry-1",
    title: "Retry semantics test",
    prompt: "Run the task",
    createdAt: Date.now() - 1000,
    successCriteria: overrides?.successCriteria,
    agentConfig: overrides?.agentConfig || {},
    maxAttempts: overrides?.maxAttempts,
  };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp",
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = {
    updateTaskStatus: vi.fn(),
    updateTask: vi.fn(),
    logEvent: vi.fn(),
  };
  executor.emitEvent = vi.fn();
  executor.logTag = "[Executor:test]";
  executor.modelId = "gpt-5.3-codex";
  executor.initialImages = [];
  executor.provider = { createMessage: vi.fn() };
  executor.toolRegistry = { cleanup: vi.fn().mockResolvedValue(undefined) };
  executor.abortController = new AbortController();
  executor.conversationHistory = [];

  executor.cancelled = false;
  executor.wrapUpRequested = false;
  executor.waitingForUserInput = false;
  executor.softDeadlineTriggered = false;
  executor.taskCompleted = false;
  executor.requiresTestRun = false;
  executor.requiresExecutionToolRun = false;
  executor.allowExecutionWithoutShell = false;
  executor.executionToolRunObserved = false;
  executor.executionToolAttemptObserved = false;
  executor.executionToolLastError = "";
  executor.planCompletedEffectively = false;

  executor.maybeHandleScheduleSlashCommand = vi.fn().mockResolvedValue(false);
  executor.resolveConversationMode = vi.fn().mockReturnValue("task");
  executor.analyzeTask = vi.fn().mockResolvedValue({});
  executor.shouldEmitAnswerFirst = vi.fn().mockReturnValue(false);
  executor.shouldShortCircuitAfterAnswerFirst = vi.fn().mockReturnValue(false);
  executor.shouldEmitPreflight = vi.fn().mockReturnValue(false);
  executor.startProgressJournal = vi.fn();
  executor.createPlan = vi.fn().mockResolvedValue(undefined);
  executor.appendConversationHistory = vi.fn((entry: Any) => {
    executor.conversationHistory.push(entry);
  });
  executor.dispatchMentionedAgentsAfterPlanning = vi.fn().mockResolvedValue(undefined);
  executor.executePlan = vi.fn().mockResolvedValue(undefined);
  executor.verifySuccessCriteria = vi
    .fn()
    .mockResolvedValue({ success: true, message: "criteria satisfied" });
  executor.spawnVerificationAgent = vi.fn().mockResolvedValue(undefined);
  executor.buildResultSummary = vi.fn().mockReturnValue("Done");
  executor.finalizeTask = vi.fn();
  executor.finalizeTaskBestEffort = vi.fn();
  executor.updateTracking = vi.fn();

  return executor as TaskExecutor & {
    emitEvent: ReturnType<typeof vi.fn>;
    executePlan: ReturnType<typeof vi.fn>;
    verifySuccessCriteria: ReturnType<typeof vi.fn>;
  };
}

describe("TaskExecutor executeUnlocked retry semantics", () => {
  it("executes only once when no success criteria and no explicit retry policy", async () => {
    const executor = createRetryExecutor({
      agentConfig: { deepWorkMode: true },
      maxAttempts: 3,
    });

    await (executor as Any).executeUnlocked();

    expect(executor.executePlan).toHaveBeenCalledTimes(1);
    expect(
      executor.emitEvent.mock.calls.filter((call: Any[]) => call[0] === "retry_started"),
    ).toHaveLength(0);
  });

  it("retries only while success criteria are failing, then stops after pass", async () => {
    const executor = createRetryExecutor({
      successCriteria: { type: "assistant_assertion", assertion: "must be true" },
      agentConfig: { deepWorkMode: true },
      maxAttempts: 3,
    });
    executor.verifySuccessCriteria = vi
      .fn()
      .mockResolvedValueOnce({ success: false, message: "first attempt failed" })
      .mockResolvedValueOnce({ success: true, message: "second attempt passed" });

    await (executor as Any).executeUnlocked();

    expect(executor.executePlan).toHaveBeenCalledTimes(2);
    expect(executor.verifySuccessCriteria).toHaveBeenCalledTimes(2);
    expect(
      executor.emitEvent.mock.calls.filter((call: Any[]) => call[0] === "retry_started"),
    ).toHaveLength(1);
  });
});

describe("TaskExecutor provider failover retry semantics", () => {
  it("switches to the next configured provider when a retryable LLM error occurs", async () => {
    const executor = createRetryExecutor();
    executor.llmCallSequence = 0;
    executor.providerRetryV2Enabled = false;
    executor.recordObservedOutputThroughput = vi.fn();
    executor.provider = { type: "openai", createMessage: vi.fn() };
    executor.modelId = "gpt-4o-mini";
    executor.modelKey = "gpt-4o-mini";
    executor.llmProfileUsed = "cheap";
    executor.resolvedModelKey = "gpt-4o-mini";
    executor.providerFailoverIndex = 0;
    executor.providerFailoverSelections = [
      {
        providerType: "openai",
        modelId: "gpt-4o-mini",
        modelKey: "gpt-4o-mini",
        llmProfileUsed: "cheap",
        resolvedModelKey: "gpt-4o-mini",
        modelSource: "provider_default",
        warnings: [],
      },
      {
        providerType: "anthropic",
        modelId: "claude-sonnet-4-5-20250514",
        modelKey: "sonnet-4-5",
        llmProfileUsed: "cheap",
        resolvedModelKey: "sonnet-4-5",
        modelSource: "provider_default",
        warnings: [],
      },
    ];
    executor.lastRoutingState = {
      currentProvider: "openai",
      currentModel: "gpt-4o-mini",
      activeProvider: "openai",
      activeModel: "gpt-4o-mini",
      routeReason: "automatic_execution",
      fallbackChain: [],
      fallbackOccurred: false,
      manualOverride: false,
      updatedAt: Date.now(),
    };
    executor.emitRoutingState = vi.fn((overrides?: Any) => {
      executor.lastRoutingState = {
        currentProvider: "openai",
        currentModel: "gpt-4o-mini",
        activeProvider: executor.provider.type,
        activeModel: executor.modelId,
        routeReason: overrides?.routeReason || "automatic_execution",
        fallbackChain: overrides?.fallbackChain || [],
        fallbackOccurred: overrides?.fallbackOccurred ?? false,
        manualOverride: overrides?.manualOverride ?? false,
        updatedAt: Date.now(),
      };
    });
    executor.applyResolvedProviderSelection = vi.fn((selection: Any) => {
      executor.provider = { type: selection.providerType, createMessage: vi.fn() };
      executor.modelId = selection.modelId;
      executor.modelKey = selection.modelKey;
      executor.llmProfileUsed = selection.llmProfileUsed;
      executor.resolvedModelKey = selection.resolvedModelKey;
    });

    const requestFn = vi.fn(async () => {
      if (executor.provider.type === "openai") {
        const error = new Error("rate limit exceeded");
        (error as Any).status = 429;
        throw error;
      }
      return {
        content: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });

    const response = await (executor as Any).callLLMWithRetry(requestFn, "provider failover");

    expect(response.stopReason).toBe("end_turn");
    expect(requestFn).toHaveBeenCalledTimes(2);
    expect(executor.provider.type).toBe("anthropic");
    expect(executor.providerFailoverIndex).toBe(1);
    expect(executor.lastRoutingState?.fallbackOccurred).toBe(true);
    expect(executor.lastRoutingState?.fallbackChain).toEqual([
      expect.objectContaining({
        providerType: "openai",
        modelKey: "gpt-4o-mini",
        success: false,
      }),
      expect.objectContaining({
        providerType: "anthropic",
        modelKey: "sonnet-4-5",
        success: true,
      }),
    ]);
  });
});

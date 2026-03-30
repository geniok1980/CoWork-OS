import { describe, expect, it } from "vitest";
import { UsageInsightsService } from "../UsageInsightsService";

function isLlmErrorQuery(sql: string): boolean {
  return sql.includes("llm_error");
}

function isLlmUsageQuery(sql: string): boolean {
  return sql.includes("llm_usage") && !sql.includes("llm_error");
}

function isPricingQuery(sql: string): boolean {
  return sql.includes("llm_pricing");
}

function isGlobalLlmUsageQuery(sql: string): boolean {
  return sql.includes("FROM llm_call_events") && sql.includes("success = 1");
}

function isGlobalLlmErrorQuery(sql: string): boolean {
  return sql.includes("FROM llm_call_events") && sql.includes("success = 0");
}

function defaultMockDb(overrides: {
  llmRows?: unknown[];
  globalLlmRows?: unknown[];
  toolRows?: unknown[];
  statusRows?: unknown[];
  personaRows?: unknown[];
  personaCostRows?: unknown[];
  feedbackRows?: unknown[];
  retryRow?: unknown;
  llmErrorResult?: { c: number };
  globalLlmErrorResult?: { c: number };
  pricingRows?: unknown[];
  awuCount?: number;
}) {
  const {
    llmRows = [],
    globalLlmRows = [],
    toolRows = [],
    statusRows = [],
    personaRows = [],
    personaCostRows = [],
    feedbackRows = [],
    retryRow = { avg_attempts: null, retried_tasks: 0, max_attempts: 0 },
    llmErrorResult = { c: 0 },
    globalLlmErrorResult = { c: 0 },
    pricingRows = [],
    awuCount = 0,
  } = overrides;
  return {
    prepare: (sql: string) => {
      if (isPricingQuery(sql)) {
        return { all: () => pricingRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("GROUP BY status")) {
        return { all: () => statusRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("GROUP BY COALESCE(t.assigned_agent_role_id")) {
        return { all: () => personaRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("SELECT created_at FROM tasks")) {
        return { all: () => [], get: () => ({ count: 0 }) };
      }
      if (sql.includes("COALESCE(t.assigned_agent_role_id, 'unassigned') as persona_id") && sql.includes("llm_usage")) {
        return { all: () => personaCostRows, get: () => ({ count: 0 }) };
      }
      if (isLlmUsageQuery(sql)) {
        return { all: () => llmRows, get: () => ({ c: 0 }) };
      }
      if (isGlobalLlmUsageQuery(sql)) {
        return { all: () => globalLlmRows, get: () => ({ c: 0 }) };
      }
      if (isLlmErrorQuery(sql)) {
        return { all: () => [], get: () => llmErrorResult };
      }
      if (isGlobalLlmErrorQuery(sql)) {
        return { all: () => [], get: () => globalLlmErrorResult };
      }
      if (sql.includes("skill_used")) {
        return { all: () => [], get: () => ({ count: 0 }) };
      }
      if (sql.includes("user_feedback")) {
        return { all: () => feedbackRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("te.type, te.legacy_type as legacy_type")) {
        return { all: () => toolRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("AVG(CASE WHEN current_attempt")) {
        return { all: () => [], get: () => retryRow };
      }
      if (sql.includes("COUNT(*) as count FROM tasks")) {
        return { all: () => [], get: () => ({ count: awuCount }) };
      }
      return { all: () => [], get: () => ({ count: 0 }) };
    },
  };
}

describe("UsageInsightsService", () => {
  it("counts legacy completed tasks with NULL terminal_status as AWUs", () => {
    const db = {
      prepare: (sql: string) => ({
        all: () => [],
        get: () => {
          if (isPricingQuery(sql)) return { count: 0 };
          if (isLlmErrorQuery(sql)) return { c: 0 };
          if (sql.includes("COUNT(*) as count FROM tasks")) {
            expect(sql).toContain("completed_at >= ? AND completed_at <= ?");
            expect(sql).not.toContain("created_at >= ? AND created_at <= ?");
            return { count: sql.includes("terminal_status IS NULL") ? 2 : 1 };
          }
          return { count: 0 };
        },
      }),
    };

    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.awuMetrics.awuCount).toBe(2);
  });

  it("aggregates token and tool execution metrics", () => {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const ts = noon.getTime();

    const llmRows = [
      {
        task_id: "task-a",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "gpt-4o",
          delta: { inputTokens: 100, outputTokens: 40, cost: 0.0123 },
        }),
      },
      {
        task_id: "task-b",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "gpt-4o-mini",
          delta: { inputTokens: 20, outputTokens: 10, cost: 0.0012 },
        }),
      },
    ];

    const toolRows = [
      { type: "tool_call", legacy_type: null, payload: JSON.stringify({ tool: "run_command" }) },
      { type: "tool_result", legacy_type: null, payload: JSON.stringify({ tool: "run_command" }) },
      { type: "tool_call", legacy_type: null, payload: JSON.stringify({ tool: "glob" }) },
      { type: "tool_error", legacy_type: null, payload: JSON.stringify({ tool: "glob" }) },
      {
        type: "timeline_step_updated",
        legacy_type: "tool_blocked",
        payload: JSON.stringify({ tool: "web_search" }),
      },
      { type: "tool_warning", legacy_type: null, payload: JSON.stringify({ tool: "glob" }) },
    ];

    const db = defaultMockDb({
      llmRows,
      toolRows,
      statusRows: [
        { status: "completed", count: 2, avg_time: 90_000 },
        { status: "failed", count: 1, avg_time: null },
      ],
    });

    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.executionMetrics.totalPromptTokens).toBe(120);
    expect(insights.executionMetrics.totalCompletionTokens).toBe(50);
    expect(insights.executionMetrics.totalTokens).toBe(170);
    expect(insights.executionMetrics.totalLlmCalls).toBe(2);
    expect(insights.executionMetrics.avgTokensPerLlmCall).toBe(85);
    expect(insights.executionMetrics.avgTokensPerTask).toBe(57);

    expect(insights.executionMetrics.totalToolCalls).toBe(2);
    expect(insights.executionMetrics.totalToolResults).toBe(1);
    expect(insights.executionMetrics.toolErrors).toBe(1);
    expect(insights.executionMetrics.toolBlocked).toBe(1);
    expect(insights.executionMetrics.toolWarnings).toBe(1);
    expect(insights.executionMetrics.uniqueTools).toBe(3);
    expect(insights.executionMetrics.toolCompletionRate).toBe(50);
    expect(insights.executionMetrics.topTools[0]).toEqual({
      tool: "glob",
      calls: 1,
      errors: 1,
    });

    expect(insights.requestsByDay.reduce((s, d) => s + d.llmCalls, 0)).toBe(2);
    expect(insights.llmSummary.distinctTaskCount).toBe(2);
    expect(insights.llmSuccessRate).toBe(100);
    expect(insights.providerBreakdown.some((p) => p.provider === "OpenAI")).toBe(true);
  });

  it("aggregates cachedTokens and cacheReadRate", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "gpt-4o",
          delta: { inputTokens: 100, outputTokens: 10, cachedTokens: 50, cost: 0 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.llmSummary.totalCachedTokens).toBe(50);
    expect(insights.llmSummary.cacheReadRate).toBe(50);
    expect(insights.costMetrics.costByModel[0].cachedTokens).toBe(50);
  });

  it("counts distinct tasks per model", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "same-model",
          delta: { inputTokens: 1, outputTokens: 1, cost: 0 },
        }),
      },
      {
        task_id: "t2",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "same-model",
          delta: { inputTokens: 1, outputTokens: 1, cost: 0 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate(null, 7);

    expect(insights.costMetrics.costByModel[0].distinctTasks).toBe(2);
    expect(insights.costMetrics.costByModel[0].calls).toBe(2);
  });

  it("computes llmSuccessRate from llm_error count", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "claude-3",
          delta: { inputTokens: 10, outputTokens: 5, cost: 0.001 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows, llmErrorResult: { c: 2 } });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.llmSuccessRate).toBeCloseTo((1 / 3) * 100, 5);
  });

  it("includes non-task llm_call_events in usage totals", () => {
    const ts = Date.now();
    const globalLlmRows = [
      {
        task_id: null,
        timestamp: ts,
        model_key: "gpt-5.4-nano",
        model_id: "gpt-5.4-nano",
        input_tokens: 240,
        output_tokens: 80,
        cached_tokens: 0,
        cost: 0,
      },
    ];
    const pricingRows = [
      {
        model_key: "gpt-5.4-nano",
        input_cost_per_mtok: 0.2,
        output_cost_per_mtok: 1.25,
        cached_input_cost_per_mtok: 0.02,
      },
    ];

    const db = defaultMockDb({ globalLlmRows, pricingRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.llmSummary.totalLlmCalls).toBe(1);
    expect(insights.llmSummary.totalInputTokens).toBe(240);
    expect(insights.llmSummary.totalOutputTokens).toBe(80);
    expect(insights.providerBreakdown.some((p) => p.provider === "OpenAI")).toBe(true);
  });

  it("estimates cost from llm_pricing table when delta.cost is 0", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "gpt-5.4-mini",
          delta: { inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 200_000, cost: 0 },
        }),
      },
    ];

    const pricingRows = [
      {
        model_key: "gpt-5.4-mini",
        input_cost_per_mtok: 0.75,
        output_cost_per_mtok: 4.5,
        cached_input_cost_per_mtok: 0.075,
      },
    ];

    const db = defaultMockDb({ llmRows, pricingRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    // billableInput = 1_000_000 - 200_000 = 800_000
    // cost = (800_000 / 1M) * 0.75 + (500_000 / 1M) * 4.5 + (200_000 / 1M) * 0.075
    // cost = 0.6 + 2.25 + 0.015 = 2.865
    expect(insights.costMetrics.totalCost).toBeCloseTo(2.865, 4);
    expect(insights.llmSummary.totalCost).toBeCloseTo(2.865, 4);
    expect(insights.costMetrics.costByModel[0].cost).toBeCloseTo(2.865, 4);
  });

  it("uses reported delta.cost when > 0 even if pricing exists", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "gpt-5.4-mini",
          delta: { inputTokens: 1_000_000, outputTokens: 500_000, cost: 1.23 },
        }),
      },
    ];

    const pricingRows = [
      {
        model_key: "gpt-5.4-mini",
        input_cost_per_mtok: 0.75,
        output_cost_per_mtok: 4.5,
        cached_input_cost_per_mtok: 0.075,
      },
    ];

    const db = defaultMockDb({ llmRows, pricingRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.costMetrics.totalCost).toBeCloseTo(1.23, 4);
  });

  it("treats :free and ollama models as zero cost", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "nvidia/nemotron-3-nano-30b-a3b:free",
          delta: { inputTokens: 500_000, outputTokens: 100_000, cost: 0 },
        }),
      },
      {
        task_id: "t2",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "qwen3.5:latest",
          delta: { inputTokens: 200_000, outputTokens: 50_000, cost: 0 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.costMetrics.totalCost).toBe(0);
    expect(insights.llmSummary.totalLlmCalls).toBe(2);
  });

  it("aggregates persona metrics with per-persona cost", () => {
    const ts = Date.now();
    const db = defaultMockDb({
      personaRows: [
        {
          persona_id: "agent-qa",
          persona_name: "QA Agent",
          total: 4,
          completed: 3,
          failed: 1,
          cancelled: 0,
          avg_time: 120_000,
          avg_attempts: 1.5,
        },
      ],
      personaCostRows: [
        {
          persona_id: "agent-qa",
          payload: JSON.stringify({
            modelKey: "gpt-4o",
            delta: { inputTokens: 100, outputTokens: 50, cost: 0.25 },
          }),
        },
        {
          persona_id: "agent-qa",
          payload: JSON.stringify({
            modelKey: "gpt-4o",
            delta: { inputTokens: 50, outputTokens: 20, cost: 0.1 },
          }),
        },
      ],
    });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.personaMetrics).toHaveLength(1);
    expect(insights.personaMetrics[0]).toMatchObject({
      personaId: "agent-qa",
      personaName: "QA Agent",
      total: 4,
      completed: 3,
      failed: 1,
    });
    expect(insights.personaMetrics[0].successRate).toBe(75);
    expect(insights.personaMetrics[0].totalCost).toBeCloseTo(0.35, 5);
  });

  it("aggregates feedback and retry metrics", () => {
    const db = defaultMockDb({
      feedbackRows: [
        { payload: JSON.stringify({ decision: "accepted", kind: "task" }) },
        { payload: JSON.stringify({ decision: "rejected", reason: "Too vague" }) },
        { payload: JSON.stringify({ rating: "negative", reason: "Missed files" }) },
      ],
      retryRow: {
        avg_attempts: 1.8,
        retried_tasks: 3,
        max_attempts: 4,
      },
      statusRows: [{ status: "completed", count: 6, avg_time: 60_000 }],
    });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.feedbackMetrics.totalFeedback).toBe(3);
    expect(insights.feedbackMetrics.accepted).toBe(1);
    expect(insights.feedbackMetrics.rejected).toBe(2);
    expect(insights.feedbackMetrics.topRejectionReasons[0]).toEqual({
      reason: "Too vague",
      count: 1,
    });
    expect(insights.retryMetrics.avgAttempts).toBe(1.8);
    expect(insights.retryMetrics.retriedTasks).toBe(3);
    expect(insights.retryMetrics.maxAttempts).toBe(4);
    expect(insights.retryMetrics.retriedRate).toBe(50);
  });
});

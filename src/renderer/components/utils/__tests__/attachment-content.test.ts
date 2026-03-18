import { describe, expect, it } from "vitest";

import {
  stripPptxBubbleContent,
  stripStrategyContextBlock,
} from "../attachment-content";

describe("attachment-content helpers", () => {
  it("strips strategy metadata blocks from rendered prompt text", () => {
    const input = `Build me a live dashboard showing system metrics

[AGENT_STRATEGY_CONTEXT_V1]
intent=execution
conversation_mode=task
[/AGENT_STRATEGY_CONTEXT_V1]`;

    expect(stripStrategyContextBlock(input)).toBe(
      "Build me a live dashboard showing system metrics",
    );
  });

  it("can remove strategy metadata after attachment cleanup", () => {
    const input = `Build me a live dashboard showing system metrics

[AGENT_STRATEGY_CONTEXT_V1]
intent=execution
[/AGENT_STRATEGY_CONTEXT_V1]

Attached files (relative to workspace):
- metrics.csv (text/csv)`;

    const cleaned = stripStrategyContextBlock(stripPptxBubbleContent(input));
    expect(cleaned).toBe("Build me a live dashboard showing system metrics");
  });
});

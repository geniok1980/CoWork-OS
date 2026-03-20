import { describe, expect, it } from "vitest";
import {
  autolinkBareDomains,
  autolinkUrlsInBrackets,
  normalizeSourcesSection,
  shouldCreateFreshTaskForSend,
} from "../MainContent";

describe("MainContent markdown normalization helpers", () => {
  it("does not rewrite non-citation sources text that only contains pipes", () => {
    const input = "Sources: see table | see appendix";
    expect(normalizeSourcesSection(input)).toBe(input);
  });

  it("splits numbered source entries onto separate lines", () => {
    const input = "Sources: [1] https://example.com | [2] https://example.org";
    const output = normalizeSourcesSection(input);

    expect(output).toContain("Sources: [1] https://example.com  \n[2] https://example.org");
  });

  it("autolinks legitimate bare domains while avoiding common abbreviations", () => {
    expect(autolinkBareDomains("Visit learn.microsoft.com for docs.")).toBe(
      "Visit [learn.microsoft.com](https://learn.microsoft.com) for docs.",
    );
    expect(autolinkBareDomains("Examples include e.g. and i.e. but not no.op.")).toBe(
      "Examples include e.g. and i.e. but not no.op.",
    );
  });

  it("autolinks bracketed URLs without touching citation indices", () => {
    expect(autolinkUrlsInBrackets("Use [learn.microsoft.com] and [https://example.com/path].")).toBe(
      "Use [learn.microsoft.com](https://learn.microsoft.com) and [https://example.com/path](https://example.com/path).",
    );
    expect(autolinkUrlsInBrackets("Citations like [1] stay unchanged.")).toBe(
      "Citations like [1] stay unchanged.",
    );
  });

  it("reuses the current chat task for follow-up messages", () => {
    expect(
      shouldCreateFreshTaskForSend({
        executionMode: "chat",
        selectedTaskId: "task-1",
        selectedTaskExecutionMode: "chat",
      }),
    ).toBe(false);
    expect(
      shouldCreateFreshTaskForSend({
        executionMode: "chat",
        selectedTaskId: "task-1",
        selectedTaskExecutionMode: "execute",
      }),
    ).toBe(false);
    expect(
      shouldCreateFreshTaskForSend({
        executionMode: "chat",
        selectedTaskId: null,
      }),
    ).toBe(true);
    expect(
      shouldCreateFreshTaskForSend({
        executionMode: "execute",
        selectedTaskId: "task-1",
        selectedTaskExecutionMode: "execute",
      }),
    ).toBe(false);
  });
});

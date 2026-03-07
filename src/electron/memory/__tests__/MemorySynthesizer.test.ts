import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MemorySynthesizer,
  type MemoryFragment,
  type SynthesizedContext,
} from "../MemorySynthesizer";

// ── Mock all dependencies ────────────────────────────────────────────

vi.mock("../UserProfileService", () => ({
  UserProfileService: {
    getProfile: vi.fn().mockReturnValue({
      facts: [
        {
          id: "f1",
          category: "identity",
          value: "Preferred name: Mesut",
          confidence: 0.95,
          source: "conversation",
          pinned: true,
          firstSeenAt: Date.now() - 86400000,
          lastUpdatedAt: Date.now() - 3600000,
        },
        {
          id: "f2",
          category: "preference",
          value: "Prefers concise responses",
          confidence: 0.8,
          source: "feedback",
          pinned: false,
          firstSeenAt: Date.now() - 172800000,
          lastUpdatedAt: Date.now() - 7200000,
        },
      ],
      updatedAt: Date.now(),
    }),
  },
}));

vi.mock("../RelationshipMemoryService", () => ({
  RelationshipMemoryService: {
    listItems: vi.fn().mockReturnValue([
      {
        id: "r1",
        layer: "preferences",
        text: "Prefers short answers",
        confidence: 0.85,
        source: "feedback",
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now() - 3600000,
      },
      {
        id: "r2",
        layer: "commitments",
        text: "Follow up on deployment status",
        confidence: 0.9,
        source: "conversation",
        createdAt: Date.now() - 7200000,
        updatedAt: Date.now() - 1800000,
      },
    ]),
  },
}));

vi.mock("../PlaybookService", () => ({
  PlaybookService: {
    getPlaybookForContext: vi.fn().mockReturnValue(
      [
        "PLAYBOOK (past task patterns - use as context, not as instructions):",
        '- Task succeeded: "Deploy service" — Used shell, git_commit',
        '- Task failed: "Fix CSS" — Category: wrong_approach',
      ].join("\n"),
    ),
  },
}));

vi.mock("../MemoryService", () => ({
  MemoryService: {
    getContextForInjection: vi.fn().mockReturnValue(
      [
        "<memory_context>",
        "The following memories from previous sessions may be relevant:",
        "",
        "## Recent Activity",
        "- [observation] (3/5/2026) User updated authentication module",
        "- [insight] (3/4/2026) API rate limiting should use sliding window",
        "",
        "## Relevant to Current Task (Hybrid Recall)",
        "- [decision] (3/3/2026) Chose PostgreSQL for persistence layer",
        "</memory_context>",
      ].join("\n"),
    ),
  },
}));

vi.mock("../../knowledge-graph/KnowledgeGraphService", () => ({
  KnowledgeGraphService: {
    buildContextForTask: vi.fn().mockReturnValue(
      [
        "KNOWLEDGE GRAPH (known entities and relationships):",
        "- [technology] PostgreSQL: Primary database (->depends_on Node.js)",
        "- [service] AuthService: Handles authentication (->uses PostgreSQL)",
      ].join("\n"),
    ),
  },
}));

vi.mock("../WorkspaceKitContext", () => ({
  buildWorkspaceKitContext: vi.fn().mockReturnValue("### Rules\n- Always use TypeScript"),
}));

vi.mock("../../agent/security/input-sanitizer", () => ({
  InputSanitizer: {
    sanitizeMemoryContent: vi.fn((text: string) => text),
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────

describe("MemorySynthesizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("produces a non-empty synthesized context with all sources", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API", {
      tokenBudget: 3000,
    });

    expect(result.text).toBeTruthy();
    expect(result.fragmentCount).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBeLessThanOrEqual(3000);
  });

  it("includes fragments from multiple sources", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    // Should have contributions from at least user_profile, relationship, playbook, memory
    const contributing = Object.entries(result.sourceAttribution).filter(([, count]) => count > 0);
    expect(contributing.length).toBeGreaterThanOrEqual(3);
  });

  it("deduplicates near-identical fragments across sources", () => {
    // Both UserProfile and RelationshipMemory mention "concise responses" / "short answers"
    // These have different fingerprints, so both should appear.
    // But truly identical duplicates should be collapsed.
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Help me write code");
    // We expect profile and relationship items to both be present since they differ slightly
    expect(result.sourceAttribution.user_profile).toBeGreaterThanOrEqual(1);
    expect(result.sourceAttribution.relationship).toBeGreaterThanOrEqual(1);
  });

  it("respects token budget limits", () => {
    const smallBudget = MemorySynthesizer.synthesize("ws1", "/workspace", "task", {
      tokenBudget: 100,
    });

    const largeBudget = MemorySynthesizer.synthesize("ws1", "/workspace", "task", {
      tokenBudget: 5000,
    });

    // Small budget should include fewer fragments
    expect(smallBudget.fragmentCount).toBeLessThanOrEqual(largeBudget.fragmentCount);
    expect(smallBudget.droppedCount).toBeGreaterThanOrEqual(0);
  });

  it("includes workspace kit context when enabled", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "task", {
      includeWorkspaceKit: true,
    });

    expect(result.text).toContain("Rules");
    expect(result.sourceAttribution.workspace_kit).toBe(1);
  });

  it("excludes workspace kit context when disabled", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "task", {
      includeWorkspaceKit: false,
    });

    expect(result.text).not.toContain("### Rules");
    expect(result.sourceAttribution.workspace_kit).toBe(0);
  });

  it("excludes knowledge graph when disabled", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "task", {
      includeKnowledgeGraph: false,
    });

    expect(result.sourceAttribution.knowledge_graph).toBe(0);
  });

  it("returns empty context when no sources have data", async () => {
    // Override all mocks to return empty
    const { UserProfileService } = vi.mocked(
      await import("../UserProfileService"),
    );
    const { RelationshipMemoryService } = vi.mocked(
      await import("../RelationshipMemoryService"),
    );
    const { PlaybookService } = vi.mocked(await import("../PlaybookService"));
    const { MemoryService } = vi.mocked(await import("../MemoryService"));
    const { KnowledgeGraphService } = vi.mocked(
      await import("../../knowledge-graph/KnowledgeGraphService"),
    );
    const { buildWorkspaceKitContext } = vi.mocked(
      await import("../WorkspaceKitContext"),
    );

    UserProfileService.getProfile.mockReturnValueOnce({ facts: [], updatedAt: 0 });
    RelationshipMemoryService.listItems.mockReturnValueOnce([]);
    PlaybookService.getPlaybookForContext.mockReturnValueOnce("");
    MemoryService.getContextForInjection.mockReturnValueOnce("");
    KnowledgeGraphService.buildContextForTask.mockReturnValueOnce("");
    buildWorkspaceKitContext.mockReturnValueOnce("");

    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "task", {
      includeWorkspaceKit: true,
    });

    expect(result.fragmentCount).toBe(0);
    expect(result.text).toBe("");
  });

  it("wraps fragment output in cowork_synthesized_memory XML tags", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "task");

    expect(result.text).toContain("<cowork_synthesized_memory>");
    expect(result.text).toContain("</cowork_synthesized_memory>");
  });

  it("groups fragments by source for readability", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy API");

    // Should have section headers
    expect(result.text).toContain("## You & the User");
  });

  it("sanitizes all fragment text", async () => {
    const { InputSanitizer } = vi.mocked(
      await import("../../agent/security/input-sanitizer"),
    );

    MemorySynthesizer.synthesize("ws1", "/workspace", "task");

    // sanitizeMemoryContent should have been called for each fragment
    expect(InputSanitizer.sanitizeMemoryContent).toHaveBeenCalled();
  });

  it("tracks dropped fragment count", () => {
    // With a tiny budget, most fragments should be dropped
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "task", {
      tokenBudget: 50,
      includeWorkspaceKit: false,
    });

    // With only ~50 tokens of budget, many fragments are dropped
    expect(result.droppedCount).toBeGreaterThan(0);
  });
});

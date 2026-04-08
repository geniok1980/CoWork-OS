import { describe, expect, it, vi } from "vitest";

const memoryFeatureMocks = vi.hoisted(() => ({
  loadSettings: vi.fn().mockReturnValue({
    sessionRecallEnabled: true,
    topicMemoryEnabled: true,
    verbatimRecallEnabled: true,
  }),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/app",
    getPath: (name: string) => `/electron/${name}`,
  },
  clipboard: { readText: () => "", writeText: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock("../../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: {
    loadSettings: memoryFeatureMocks.loadSettings,
  },
}));

import { SystemTools } from "../system-tools";
import { LayeredMemoryIndexService } from "../../../memory/LayeredMemoryIndexService";

describe("SystemTools.normalizeAppleScript", () => {
  // Access the private method through a test-only technique
  function callNormalize(input: string): { script: string; modified: boolean } {
    const instance = new SystemTools(
      {
        id: "ws-1",
        name: "test",
        path: "/tmp",
        createdAt: 0,
        permissions: { read: true, write: true, delete: false, network: false, shell: false },
      },
      { logEvent: vi.fn(), requestApproval: vi.fn() } as Any,
      "task-1",
    );
    // Access private method for testing
    return (instance as Any).normalizeAppleScript(input);
  }

  it("returns unmodified script as-is", () => {
    const result = callNormalize('tell application "Finder" to get name');
    expect(result.script).toBe('tell application "Finder" to get name');
    expect(result.modified).toBe(false);
  });

  it("strips fenced code blocks", () => {
    const result = callNormalize('```applescript\ntell app "Finder" to beep\n```');
    expect(result.script).toBe('tell app "Finder" to beep');
    expect(result.modified).toBe(true);
  });

  it("strips fenced code blocks without language tag", () => {
    const result = callNormalize('```\ntell app "Finder" to beep\n```');
    expect(result.script).toBe('tell app "Finder" to beep');
    expect(result.modified).toBe(true);
  });

  it("replaces smart double quotes", () => {
    const result = callNormalize("tell application \u201CFinder\u201D to beep");
    expect(result.script).toBe('tell application "Finder" to beep');
    expect(result.modified).toBe(true);
  });

  it("replaces smart single quotes", () => {
    const result = callNormalize("it\u2019s a test");
    expect(result.script).toBe("it's a test");
    expect(result.modified).toBe(true);
  });

  it("removes non-breaking spaces", () => {
    const result = callNormalize('tell\u00A0application "Finder"');
    expect(result.script).toBe('tell application "Finder"');
    expect(result.modified).toBe(true);
  });

  it("handles multiple normalizations at once", () => {
    const result = callNormalize("```applescript\ntell\u00A0app \u201CFinder\u201D\n```");
    expect(result.script).toBe('tell app "Finder"');
    expect(result.modified).toBe(true);
  });
});

describe("SystemTools.getToolDefinitions", () => {
  it("returns all tools in non-headless mode", () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
    });
    const tools = SystemTools.getToolDefinitions();
    expect(tools.length).toBeGreaterThan(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("system_info");
    expect(names).toContain("read_clipboard");
    expect(names).toContain("run_applescript");
    expect(names).toContain("search_memories");
    expect(names).toContain("search_quotes");
    expect(names).toContain("search_sessions");
    expect(names).toContain("memory_topics_load");
  });

  it("returns only safe tools in headless mode", () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
    });
    const tools = SystemTools.getToolDefinitions({ headless: true });
    expect(tools).toHaveLength(7);
    const names = tools.map((t) => t.name);
    expect(names).toContain("system_info");
    expect(names).toContain("get_env");
    expect(names).toContain("get_app_paths");
    expect(names).toContain("search_memories");
    expect(names).toContain("search_quotes");
    expect(names).toContain("search_sessions");
    expect(names).toContain("memory_topics_load");
    // Desktop-only tools should be excluded
    expect(names).not.toContain("read_clipboard");
    expect(names).not.toContain("take_screenshot");
    expect(names).not.toContain("open_application");
    expect(names).not.toContain("open_url");
    expect(names).not.toContain("run_applescript");
  });

  it("returns full tools when headless is false", () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
    });
    const tools = SystemTools.getToolDefinitions({ headless: false });
    expect(tools.length).toBeGreaterThan(4);
  });

  it("hides disabled recall tools", () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: false,
      topicMemoryEnabled: false,
      verbatimRecallEnabled: false,
    });
    const tools = SystemTools.getToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("search_quotes");
    expect(names).not.toContain("search_sessions");
    expect(names).not.toContain("memory_topics_load");
  });
});

describe("SystemTools.searchMemories", () => {
  it("returns empty results on error", async () => {
    vi.mock("../../memory/MemoryService", () => ({
      MemoryService: {
        search: vi.fn(() => {
          throw new Error("DB not initialized");
        }),
      },
    }));

    const instance = new SystemTools(
      {
        id: "ws-1",
        name: "test",
        path: "/tmp",
        createdAt: 0,
        permissions: { read: true, write: true, delete: false, network: false, shell: false },
      },
      { logEvent: vi.fn(), requestApproval: vi.fn() } as Any,
      "task-1",
    );

    const result = await instance.searchMemories({ query: "test" });
    expect(result.results).toEqual([]);
    expect(result.totalFound).toBe(0);
  });
});

describe("SystemTools memory feature gating", () => {
  function createInstance(): SystemTools {
    return new SystemTools(
      {
        id: "ws-1",
        name: "test",
        path: "/tmp",
        createdAt: 0,
        permissions: { read: true, write: true, delete: false, network: false, shell: false },
      },
      { logEvent: vi.fn(), requestApproval: vi.fn() } as Any,
      "task-1",
    );
  }

  it("rejects search_sessions when session recall is disabled", async () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: false,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
    });
    const instance = createInstance();
    await expect(instance.searchSessions({ query: "deploy" })).rejects.toThrow(/disabled/i);
  });

  it("rejects search_quotes when verbatim recall is disabled", async () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: false,
    });
    const instance = createInstance();
    await expect(instance.searchQuotes({ query: "deploy" })).rejects.toThrow(/disabled/i);
  });

  it("rejects memory_topics_load when topic memory is disabled", async () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: true,
      topicMemoryEnabled: false,
      verbatimRecallEnabled: true,
    });
    const instance = createInstance();
    await expect(instance.loadMemoryTopics({ query: "deploy" })).rejects.toThrow(/disabled/i);
  });

  it("loads existing topic snippets by default when refresh is omitted", async () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
    });
    const loadSpy = vi
      .spyOn(LayeredMemoryIndexService, "loadRelevantTopicSnippets")
      .mockResolvedValue([
        {
          title: "Deploy",
          path: "/tmp/topics/deploy.md",
          content: "Use the rollout checklist.",
          source: "markdown",
        },
      ] as Any);
    const refreshSpy = vi
      .spyOn(LayeredMemoryIndexService, "refreshIndex")
      .mockResolvedValue({ topics: [] } as Any);
    const resolveIndexSpy = vi
      .spyOn(LayeredMemoryIndexService, "resolveMemoryIndexPath")
      .mockReturnValue("/tmp/.cowork/memory/index.json");

    const instance = createInstance();
    const result = await instance.loadMemoryTopics({ query: "deploy" });

    expect(loadSpy).toHaveBeenCalledOnce();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(resolveIndexSpy).toHaveBeenCalled();
    expect(result.topics).toHaveLength(1);
  });

  it("refreshes the topic index when refresh is explicitly true", async () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
    });
    const loadSpy = vi
      .spyOn(LayeredMemoryIndexService, "loadRelevantTopicSnippets")
      .mockResolvedValue([] as Any);
    const refreshSpy = vi
      .spyOn(LayeredMemoryIndexService, "refreshIndex")
      .mockResolvedValue({
        topics: [
          {
            title: "Deploy",
            path: "/tmp/topics/deploy.md",
            content: "Rebuild the index first.",
            source: "memory",
          },
        ],
      } as Any);
    vi.spyOn(LayeredMemoryIndexService, "resolveMemoryIndexPath").mockReturnValue(
      "/tmp/.cowork/memory/index.json",
    );
    loadSpy.mockClear();
    refreshSpy.mockClear();

    const instance = createInstance();
    const result = await instance.loadMemoryTopics({ query: "deploy", refresh: true });

    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(loadSpy).not.toHaveBeenCalled();
    expect(result.topics[0]?.title).toBe("Deploy");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImprovementCandidate } from "../../../shared/types";

const tasks = new Map<string, Any>();
const workspaces: Any[] = [];
const candidates = new Map<string, ImprovementCandidate>();
let recentTaskRows: Array<{ id: string }> = [];
let recentEventRows: Any[] = [];
let logExists = true;
let logContents =
  "[10:00:01] Error: preload bridge exploded\n[10:00:02] uncaught exception while loading panel";

vi.mock("fs", () => {
  const mockFs = {
    existsSync: vi.fn(() => logExists),
    readFileSync: vi.fn(() => logContents),
  };
  return {
    default: mockFs,
    ...mockFs,
  };
});

vi.mock("../ImprovementSettingsManager", () => ({
  ImprovementSettingsManager: {
    loadSettings: () => ({
      enabled: true,
      autoRun: false,
      includeDevLogs: true,
      intervalMinutes: 1440,
      maxConcurrentExperiments: 1,
      maxOpenCandidatesPerWorkspace: 25,
      requireWorktree: true,
      reviewRequired: true,
      evalWindowDays: 14,
    }),
  },
}));

vi.mock("../../database/repositories", () => ({
  TaskRepository: class {
    findById(id: string) {
      return tasks.get(id);
    }
  },
  WorkspaceRepository: class {
    findAll() {
      return [...workspaces];
    }
  },
}));

vi.mock("../ImprovementRepositories", () => ({
  ImprovementCandidateRepository: class {
    create(input: Any) {
      const candidate = {
        ...input,
        id: input.id || `candidate-${candidates.size + 1}`,
        firstSeenAt: input.firstSeenAt ?? Date.now(),
        lastSeenAt: input.lastSeenAt ?? Date.now(),
      };
      candidates.set(candidate.id, candidate);
      return candidate;
    }

    update(id: string, updates: Any) {
      const existing = candidates.get(id);
      if (!existing) return;
      candidates.set(id, { ...existing, ...updates });
    }

    findById(id: string) {
      return candidates.get(id);
    }

    findByFingerprint(workspaceId: string, fingerprint: string) {
      return [...candidates.values()].find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.fingerprint === fingerprint,
      );
    }

    list(params?: Any) {
      let rows = [...candidates.values()];
      if (params?.workspaceId) {
        rows = rows.filter((candidate) => candidate.workspaceId === params.workspaceId);
      }
      return rows.sort((a, b) => b.priorityScore - a.priorityScore);
    }

    getTopRunnableCandidate(workspaceId: string) {
      return [...candidates.values()]
        .filter((candidate) => candidate.workspaceId === workspaceId && candidate.status === "open")
        .sort((a, b) => b.priorityScore - a.priorityScore)[0];
    }
  },
}));

import { ImprovementCandidateService } from "../ImprovementCandidateService";

describe("ImprovementCandidateService", () => {
  let db: Any;

  beforeEach(() => {
    tasks.clear();
    candidates.clear();
    workspaces.length = 0;
    recentTaskRows = [];
    recentEventRows = [];
    logExists = true;
    logContents =
      "[10:00:01] Error: preload bridge exploded\n[10:00:02] uncaught exception while loading panel";
    db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM tasks")) {
          return {
            all: vi.fn(() => recentTaskRows),
          };
        }
        if (sql.includes("FROM task_events")) {
          return {
            all: vi.fn(() => recentEventRows),
          };
        }
        return {
          all: vi.fn(() => []),
          get: vi.fn(() => undefined),
        };
      }),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds candidates from failed tasks, user feedback, and dev logs without double-counting refreshes", async () => {
    workspaces.push({
      id: "workspace-1",
      path: "/tmp/workspace-1",
    });
    tasks.set("task-1", {
      id: "task-1",
      title: "Broken verification flow",
      prompt: "Fix the failing verification flow",
      status: "failed",
      workspaceId: "workspace-1",
      terminalStatus: "failed",
      failureClass: "contract_error",
      resultSummary: "Post-completion verifier still fails on missing report artifact.",
    });
    recentTaskRows = [{ id: "task-1" }];
    recentEventRows = [
      {
        task_id: "task-1",
        type: "user_feedback",
        payload: JSON.stringify({
          decision: "rejected",
          reason: "The verifier still fails after completion.",
        }),
        id: "event-1",
        timestamp: Date.now(),
      },
    ];

    const service = new ImprovementCandidateService(db);
    await service.refresh();
    const firstPass = service.listCandidates("workspace-1");

    expect(firstPass.some((candidate) => candidate.source === "task_failure")).toBe(true);
    expect(firstPass.some((candidate) => candidate.source === "user_feedback")).toBe(true);
    expect(firstPass.some((candidate) => candidate.source === "dev_log")).toBe(true);

    await service.refresh();
    const secondPass = service.listCandidates("workspace-1");
    const taskFailure = secondPass.find((candidate) => candidate.source === "task_failure");
    const userFeedback = secondPass.find((candidate) => candidate.source === "user_feedback");

    expect(secondPass).toHaveLength(firstPass.length);
    expect(taskFailure?.recurrenceCount).toBe(1);
    expect(userFeedback?.recurrenceCount).toBe(1);
  });
});

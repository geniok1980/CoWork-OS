import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { ImprovementCandidate, ImprovementRun, Task, Workspace } from "../../../shared/types";
import { ImprovementLoopService } from "../ImprovementLoopService";

const workspaces = new Map<string, Workspace>();
const tasks = new Map<string, Task>();
const runs = new Map<string, ImprovementRun>();
const candidates = new Map<string, ImprovementCandidate>();
let mockSettings = {
  enabled: true,
  autoRun: false,
  includeDevLogs: false,
  intervalMinutes: 1440,
  maxConcurrentExperiments: 1,
  maxOpenCandidatesPerWorkspace: 25,
  requireWorktree: true,
  reviewRequired: true,
  promotionMode: "github_pr" as const,
  evalWindowDays: 14,
};

vi.mock("../ImprovementSettingsManager", () => ({
  ImprovementSettingsManager: {
    loadSettings: () => mockSettings,
    saveSettings: vi.fn(),
  },
}));

vi.mock("../../database/repositories", () => ({
  WorkspaceRepository: class {
    findAll() {
      return [...workspaces.values()];
    }

    findById(id: string) {
      return workspaces.get(id);
    }
  },
  TaskRepository: class {
    findById(id: string) {
      return tasks.get(id);
    }
  },
}));

vi.mock("../ImprovementRepositories", () => ({
  ImprovementCandidateRepository: class {
    list() {
      return [] as ImprovementCandidate[];
    }

    findById(id: string) {
      return candidates.get(id);
    }
  },
  ImprovementRunRepository: class {
    create(input: Any) {
      const run: ImprovementRun = {
        ...input,
        id: `run-${runs.size + 1}`,
        createdAt: input.createdAt ?? Date.now(),
      };
      runs.set(run.id, run);
      return run;
    }

    update(id: string, updates: Partial<ImprovementRun>) {
      const existing = runs.get(id);
      if (!existing) return;
      runs.set(id, { ...existing, ...updates });
    }

    findById(id: string) {
      return runs.get(id);
    }

    findByTaskId(taskId: string) {
      return [...runs.values()].find((run) => run.taskId === taskId);
    }

    list() {
      return [...runs.values()];
    }

    countActive() {
      return [...runs.values()].filter((run) => run.status === "queued" || run.status === "running").length;
    }
  },
}));

vi.mock("../ExperimentEvaluationService", () => ({
  ExperimentEvaluationService: class {
    snapshot(windowDays: number) {
      return {
        generatedAt: Date.now(),
        windowDays,
        taskSuccessRate: 0.5,
        approvalDeadEndRate: 0.1,
        verificationPassRate: 0.6,
        retriesPerTask: 1,
        toolFailureRateByTool: [],
      };
    }

    evaluateRun(params: Any) {
      return {
        runId: params.runId,
        passed: true,
        summary: "Experiment passed targeted checks and is ready for review.",
        notes: ["Verification passed."],
        targetedVerificationPassed: true,
        verificationPassed: true,
        baselineMetrics: this.snapshot(params.evalWindowDays),
        outcomeMetrics: this.snapshot(params.evalWindowDays),
      };
    }
  },
}));

describe("ImprovementLoopService", () => {
  beforeEach(() => {
    workspaces.clear();
    tasks.clear();
    runs.clear();
    candidates.clear();
    mockSettings = {
      enabled: true,
      autoRun: false,
      includeDevLogs: false,
      intervalMinutes: 1440,
      maxConcurrentExperiments: 1,
      maxOpenCandidatesPerWorkspace: 25,
      requireWorktree: true,
      reviewRequired: true,
      promotionMode: "github_pr",
      evalWindowDays: 14,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("launches a branch-scoped improvement task and opens a PR for an accepted review", async () => {
    workspaces.set("workspace-1", {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace-1",
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: false,
        network: true,
        shell: true,
      },
    });

    const candidate: ImprovementCandidate = {
      id: "candidate-1",
      workspaceId: "workspace-1",
      fingerprint: "candidate-fingerprint",
      source: "verification_failure",
      status: "open",
      title: "Fix verifier-detected regressions",
      summary: "Verifier fails because completion artifacts are missing.",
      severity: 0.95,
      recurrenceCount: 2,
      fixabilityScore: 0.9,
      priorityScore: 0.92,
      evidence: [
        {
          type: "verification_failure",
          taskId: "task-old",
          summary: "Verifier still fails after task completion.",
          createdAt: Date.now(),
        },
      ],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      listCandidates: vi.fn().mockReturnValue([candidate]),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;
    const notify = vi.fn();
    const loopService = new ImprovementLoopService({} as Any, candidateService, { notify });

    const daemon = new EventEmitter() as Any;
    const openPullRequest = vi
      .fn()
      .mockResolvedValue({ success: true, number: 42, url: "https://github.com/test/repo/pull/42" });
    daemon.createTask = vi.fn().mockImplementation(async (params: Any) => {
      const task: Task = {
        id: "task-improvement-1",
        title: params.title,
        prompt: params.prompt,
        status: "executing",
        workspaceId: params.workspaceId,
        agentConfig: params.agentConfig,
        source: params.source,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.set(task.id, task);
      return task;
    });
    daemon.getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(true),
      mergeToBase: vi.fn(),
      openPullRequest,
    }));

    await loopService.start(daemon);
    const run = await loopService.runNextExperiment();

    expect(run?.status).toBe("running");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Improvement run started",
      }),
    );
    expect(daemon.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "improvement",
        agentConfig: expect.objectContaining({
          autonomousMode: true,
          allowUserInput: false,
          requireWorktree: true,
          autoApproveTypes: ["run_command"],
          executionMode: "verified",
        }),
      }),
    );

    const createdTaskId = run?.taskId;
    expect(createdTaskId).toBeTruthy();
    tasks.set(createdTaskId!, {
      ...(tasks.get(createdTaskId!) as Task),
      status: "completed",
      completedAt: Date.now(),
      terminalStatus: "ok",
      resultSummary: "Added the missing artifact write and verified the regression is fixed.",
    });

    daemon.emit("task_completed", { taskId: createdTaskId });

    await vi.waitFor(() => {
      const updatedRun = runs.get(run!.id);
      expect(updatedRun?.status).toBe("passed");
      expect(updatedRun?.reviewStatus).toBe("pending");
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task_completed",
        title: "Improvement ready for review",
      }),
    );

    const promoted = await loopService.reviewRun(run!.id, "accepted");
    expect(openPullRequest).toHaveBeenCalledWith(
      createdTaskId,
      expect.objectContaining({
        title: expect.stringContaining(candidate.title),
        body: expect.stringContaining(candidate.summary),
      }),
    );
    expect(promoted?.reviewStatus).toBe("accepted");
    expect(promoted?.promotionStatus).toBe("pr_opened");
    expect(promoted?.pullRequest?.success).toBe(true);
    expect(promoted?.pullRequest?.number).toBe(42);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task_completed",
        title: "Improvement PR created",
      }),
    );

    expect(candidateService.markCandidateRunning).toHaveBeenCalledWith(candidate.id);
    expect(candidateService.markCandidateReview).toHaveBeenCalledWith(candidate.id);
    expect(candidateService.markCandidateResolved).toHaveBeenCalledWith(candidate.id);
  });

  it("merges accepted reviews when promotion mode is set to merge", async () => {
    mockSettings = {
      ...mockSettings,
      promotionMode: "merge",
    };
    workspaces.set("workspace-1", {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace-1",
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: false,
        network: true,
        shell: true,
      },
    });

    const candidate: ImprovementCandidate = {
      id: "candidate-1",
      workspaceId: "workspace-1",
      fingerprint: "candidate-fingerprint",
      source: "verification_failure",
      status: "open",
      title: "Fix verifier-detected regressions",
      summary: "Verifier fails because completion artifacts are missing.",
      severity: 0.95,
      recurrenceCount: 2,
      fixabilityScore: 0.9,
      priorityScore: 0.92,
      evidence: [
        {
          type: "verification_failure",
          taskId: "task-old",
          summary: "Verifier still fails after task completion.",
          createdAt: Date.now(),
        },
      ],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      listCandidates: vi.fn().mockReturnValue([candidate]),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;
    const notify = vi.fn();
    const loopService = new ImprovementLoopService({} as Any, candidateService, { notify });

    const daemon = new EventEmitter() as Any;
    const mergeToBase = vi.fn().mockResolvedValue({ success: true, mergeSha: "abc123" });
    daemon.createTask = vi.fn().mockImplementation(async (params: Any) => {
      const task: Task = {
        id: "task-improvement-1",
        title: params.title,
        prompt: params.prompt,
        status: "executing",
        workspaceId: params.workspaceId,
        agentConfig: params.agentConfig,
        source: params.source,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.set(task.id, task);
      return task;
    });
    daemon.getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(true),
      mergeToBase,
      openPullRequest: vi.fn(),
    }));

    await loopService.start(daemon);
    const run = await loopService.runNextExperiment();
    const createdTaskId = run?.taskId;
    tasks.set(createdTaskId!, {
      ...(tasks.get(createdTaskId!) as Task),
      status: "completed",
      completedAt: Date.now(),
      terminalStatus: "ok",
    });

    daemon.emit("task_completed", { taskId: createdTaskId });

    await vi.waitFor(() => {
      expect(runs.get(run!.id)?.status).toBe("passed");
    });

    const promoted = await loopService.reviewRun(run!.id, "accepted");
    expect(mergeToBase).toHaveBeenCalledWith(createdTaskId);
    expect(promoted?.promotionStatus).toBe("merged");
    expect(promoted?.mergeResult?.success).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task_completed",
        title: "Improvement merged",
      }),
    );
  });

  it("removes daemon listeners when stopped", async () => {
    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 0 }),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn(),
    } as Any;
    const loopService = new ImprovementLoopService({} as Any, candidateService);
    const daemon = new EventEmitter() as Any;

    await loopService.start(daemon);

    expect(daemon.listenerCount("worktree_created")).toBe(1);
    expect(daemon.listenerCount("task_completed")).toBe(1);
    expect(daemon.listenerCount("task_status")).toBe(1);

    loopService.stop();

    expect(daemon.listenerCount("worktree_created")).toBe(0);
    expect(daemon.listenerCount("task_completed")).toBe(0);
    expect(daemon.listenerCount("task_status")).toBe(0);
  });

  it("skips improvement candidates in workspaces that cannot use required worktrees", async () => {
    workspaces.set("workspace-1", {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/non-git-workspace",
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: false,
        network: true,
        shell: true,
      },
    });

    const candidate: ImprovementCandidate = {
      id: "candidate-1",
      workspaceId: "workspace-1",
      fingerprint: "candidate-fingerprint",
      source: "verification_failure",
      status: "open",
      title: "Fix verifier-detected regressions",
      summary: "Verifier fails because completion artifacts are missing.",
      severity: 0.95,
      recurrenceCount: 2,
      fixabilityScore: 0.9,
      priorityScore: 0.92,
      evidence: [
        {
          type: "verification_failure",
          taskId: "task-old",
          summary: "Verifier still fails after task completion.",
          createdAt: Date.now(),
        },
      ],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    candidates.set(candidate.id, candidate);

    const candidateService = {
      refresh: vi.fn().mockResolvedValue({ candidateCount: 1 }),
      dismissCandidate: vi.fn(),
      markCandidateRunning: vi.fn(),
      markCandidateReview: vi.fn(),
      markCandidateResolved: vi.fn(),
      reopenCandidate: vi.fn(),
      getTopCandidateForWorkspace: vi.fn().mockReturnValue(candidate),
    } as Any;
    const loopService = new ImprovementLoopService({} as Any, candidateService);

    const daemon = new EventEmitter() as Any;
    daemon.createTask = vi.fn();
    daemon.getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(false),
      mergeToBase: vi.fn(),
      openPullRequest: vi.fn(),
    }));

    await loopService.start(daemon);
    await expect(loopService.runNextExperiment()).resolves.toBeNull();
    expect(daemon.createTask).not.toHaveBeenCalled();
    expect(candidateService.markCandidateRunning).not.toHaveBeenCalled();
  });
});

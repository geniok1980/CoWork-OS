import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";
import type {
  ImprovementCandidate,
  ImprovementLoopSettings,
  ImprovementReviewStatus,
  ImprovementRun,
  NotificationType,
} from "../../shared/types";
import { buildImprovementExperimentPrompt } from "./ExperimentPromptBuilder";
import { ImprovementCandidateService } from "./ImprovementCandidateService";
import { ExperimentEvaluationService } from "./ExperimentEvaluationService";
import { ImprovementCandidateRepository, ImprovementRunRepository } from "./ImprovementRepositories";
import { ImprovementSettingsManager } from "./ImprovementSettingsManager";

interface ImprovementLoopServiceDeps {
  notify?: (params: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    workspaceId?: string;
  }) => Promise<void> | void;
}

export class ImprovementLoopService {
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly taskRepo: TaskRepository;
  private readonly candidateRepo: ImprovementCandidateRepository;
  private readonly runRepo: ImprovementRunRepository;
  private readonly evaluationService: ExperimentEvaluationService;
  private agentDaemon: AgentDaemon | null = null;
  private intervalHandle?: ReturnType<typeof setInterval>;
  private worktreeCreatedListener?: (evt: Any) => void;
  private taskCompletedListener?: (evt: Any) => void;
  private taskStatusListener?: (evt: Any) => void;
  private started = false;

  constructor(
    private readonly db: Database.Database,
    private readonly candidateService: ImprovementCandidateService,
    private readonly deps: ImprovementLoopServiceDeps = {},
  ) {
    this.workspaceRepo = new WorkspaceRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.candidateRepo = new ImprovementCandidateRepository(db);
    this.runRepo = new ImprovementRunRepository(db);
    this.evaluationService = new ExperimentEvaluationService(db);
  }

  async start(agentDaemon: AgentDaemon): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.agentDaemon = agentDaemon;

    this.worktreeCreatedListener = (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      const run = this.runRepo.findByTaskId(taskId);
      if (!run) return;
      const branch =
        typeof evt?.payload?.branch === "string"
          ? evt.payload.branch
          : typeof evt?.branch === "string"
            ? evt.branch
            : "";
      if (branch) {
        this.runRepo.update(run.id, { branchName: branch });
      }
    };
    agentDaemon.on("worktree_created", this.worktreeCreatedListener);

    const finalize = (taskId: string) => {
      const run = this.runRepo.findByTaskId(taskId);
      if (!run || (run.status !== "queued" && run.status !== "running")) return;
      void this.finalizeRun(run.id, taskId);
    };

    this.taskCompletedListener = (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (taskId) finalize(taskId);
    };
    agentDaemon.on("task_completed", this.taskCompletedListener);

    this.taskStatusListener = (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (taskId) finalize(taskId);
    };
    agentDaemon.on("task_status", this.taskStatusListener);

    await this.refreshCandidates();
    this.resetInterval();
    const settings = this.getSettings();
    if (settings.enabled && settings.autoRun) {
      await this.runNextExperiment();
    }
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    if (this.agentDaemon && this.worktreeCreatedListener) {
      this.agentDaemon.removeListener("worktree_created", this.worktreeCreatedListener);
    }
    if (this.agentDaemon && this.taskCompletedListener) {
      this.agentDaemon.removeListener("task_completed", this.taskCompletedListener);
    }
    if (this.agentDaemon && this.taskStatusListener) {
      this.agentDaemon.removeListener("task_status", this.taskStatusListener);
    }
    this.worktreeCreatedListener = undefined;
    this.taskCompletedListener = undefined;
    this.taskStatusListener = undefined;
    this.agentDaemon = null;
    this.started = false;
  }

  getSettings(): ImprovementLoopSettings {
    return ImprovementSettingsManager.loadSettings();
  }

  saveSettings(settings: ImprovementLoopSettings): ImprovementLoopSettings {
    ImprovementSettingsManager.saveSettings(settings);
    const next = ImprovementSettingsManager.loadSettings();
    this.resetInterval();
    return next;
  }

  listCandidates(workspaceId?: string): ImprovementCandidate[] {
    return this.candidateRepo.list({ workspaceId });
  }

  listRuns(workspaceId?: string): ImprovementRun[] {
    return this.runRepo.list({ workspaceId });
  }

  async refreshCandidates(): Promise<{ candidateCount: number }> {
    return this.candidateService.refresh();
  }

  dismissCandidate(candidateId: string): ImprovementCandidate | undefined {
    return this.candidateService.dismissCandidate(candidateId);
  }

  async reviewRun(
    runId: string,
    reviewStatus: ImprovementReviewStatus,
  ): Promise<ImprovementRun | undefined> {
    const run = this.runRepo.findById(runId);
    if (!run) return undefined;

    if (reviewStatus === "dismissed") {
      this.runRepo.update(runId, {
        reviewStatus,
        promotionStatus:
          run.promotionStatus === "merged" || run.promotionStatus === "pr_opened"
            ? run.promotionStatus
            : "idle",
        promotionError: undefined,
      });
      this.candidateService.reopenCandidate(run.candidateId);
      void this.notify({
        type: "info",
        title: "Improvement dismissed",
        message: run.verdictSummary || "A self-improvement run was dismissed from the review queue.",
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    if (run.status !== "passed" || !run.taskId) {
      this.runRepo.update(runId, {
        promotionStatus: "promotion_failed",
        promotionError: "Only successful improvement runs with a task worktree can be promoted.",
      });
      void this.notify({
        type: "warning",
        title: "Improvement could not be promoted",
        message: "Only successful improvement runs with a task worktree can be promoted.",
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    return await this.promoteRun(runId, run.taskId, reviewStatus);
  }

  private async promoteRun(
    runId: string,
    taskId: string,
    reviewStatus: ImprovementReviewStatus = "accepted",
  ): Promise<ImprovementRun | undefined> {
    const run = this.runRepo.findById(runId);
    if (!run) return undefined;
    const candidate = this.candidateRepo.findById(run.candidateId);
    const promotionMode = this.getSettings().promotionMode;

    this.runRepo.update(runId, {
      promotionStatus: "promoting",
      promotionError: undefined,
    });

    if (!this.agentDaemon) {
      this.runRepo.update(runId, {
        reviewStatus: "pending",
        promotionStatus: "promotion_failed",
        promotionError: "Agent daemon unavailable",
      });
      void this.notify({
        type: "error",
        title: "Improvement promotion failed",
        message: "Agent daemon unavailable.",
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    if (promotionMode === "github_pr") {
      const pullRequest = await this.agentDaemon.getWorktreeManager().openPullRequest(taskId, {
        title: this.buildPullRequestTitle(candidate, run),
        body: this.buildPullRequestBody(candidate, run),
      });
      if (pullRequest.success) {
        this.runRepo.update(runId, {
          reviewStatus,
          promotionStatus: "pr_opened",
          pullRequest,
          mergeResult: undefined,
          promotionError: undefined,
          promotedAt: Date.now(),
        });
        this.candidateService.markCandidateResolved(run.candidateId);
        void this.notify({
          type: "task_completed",
          title: "Improvement PR created",
          message: pullRequest.url
            ? `Opened PR for "${candidate?.title || run.verdictSummary || "self-improvement run"}".`
            : "A self-improvement run was promoted as a pull request.",
          taskId: run.taskId,
          workspaceId: run.workspaceId,
        });
        return this.runRepo.findById(runId);
      }

      this.runRepo.update(runId, {
        reviewStatus: "pending",
        promotionStatus: "promotion_failed",
        pullRequest,
        promotionError: pullRequest.error || "Failed to open pull request",
      });
      this.candidateService.markCandidateReview(run.candidateId);
      void this.notify({
        type: "warning",
        title: "Improvement PR failed",
        message: pullRequest.error || "Failed to open pull request.",
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    const mergeResult = await this.agentDaemon.getWorktreeManager().mergeToBase(taskId);
    if (mergeResult.success) {
      this.runRepo.update(runId, {
        reviewStatus,
        promotionStatus: "merged",
        mergeResult,
        pullRequest: undefined,
        promotionError: undefined,
        promotedAt: Date.now(),
      });
      this.candidateService.markCandidateResolved(run.candidateId);
      void this.notify({
        type: "task_completed",
        title: "Improvement merged",
        message: `Merged "${candidate?.title || run.verdictSummary || "self-improvement run"}" into the base branch.`,
        taskId: run.taskId,
        workspaceId: run.workspaceId,
      });
      return this.runRepo.findById(runId);
    }

    this.runRepo.update(runId, {
      reviewStatus: "pending",
      promotionStatus: "promotion_failed",
      mergeResult,
      promotionError: mergeResult?.error || "Merge failed",
    });
    this.candidateService.markCandidateReview(run.candidateId);
    void this.notify({
      type: "warning",
      title: "Improvement merge failed",
      message: mergeResult?.error || "Merge failed.",
      taskId: run.taskId,
      workspaceId: run.workspaceId,
    });
    return this.runRepo.findById(runId);
  }

  async runNextExperiment(): Promise<ImprovementRun | null> {
    const settings = this.getSettings();
    if (!settings.enabled) return null;
    if (this.runRepo.countActive() >= settings.maxConcurrentExperiments) {
      return null;
    }

    const candidate = await this.pickNextCandidate(settings.requireWorktree);
    if (!candidate) return null;
    const workspace = this.workspaceRepo.findById(candidate.workspaceId);
    if (!workspace || workspace.isTemp) return null;

    const baselineMetrics = this.evaluationService.snapshot(settings.evalWindowDays);
    const run = this.runRepo.create({
      candidateId: candidate.id,
      workspaceId: candidate.workspaceId,
      status: "queued",
      reviewStatus: "pending",
      baselineMetrics,
    });

    this.candidateService.markCandidateRunning(candidate.id);

    try {
      if (!this.agentDaemon) {
        throw new Error("Agent daemon unavailable");
      }
      const task = await this.agentDaemon.createTask({
        title: `Improve: ${candidate.title}`,
        prompt: buildImprovementExperimentPrompt(candidate),
        workspaceId: candidate.workspaceId,
        source: "improvement",
        agentConfig: {
          autonomousMode: true,
          allowUserInput: false,
          requireWorktree: settings.requireWorktree,
          autoApproveTypes: ["run_command"],
          pauseForRequiredDecision: false,
          executionMode: "verified",
          taskDomain: "code",
          reviewPolicy: "strict",
          verificationAgent: true,
          deepWorkMode: true,
          autoContinueOnTurnLimit: true,
          maxAutoContinuations: 1,
          progressJournalEnabled: true,
          gatewayContext: "private",
        },
      });

      this.runRepo.update(run.id, {
        taskId: task.id,
        status: "running",
        startedAt: Date.now(),
      });
      void this.notify({
        type: "info",
        title: "Improvement run started",
        message: `Started autonomous improvement task for "${candidate.title}".`,
        taskId: task.id,
        workspaceId: candidate.workspaceId,
      });
    } catch (error) {
      this.runRepo.update(run.id, {
        status: "failed",
        completedAt: Date.now(),
        verdictSummary: String((error as Error)?.message || error),
      });
      this.candidateService.reopenCandidate(candidate.id);
      void this.notify({
        type: "task_failed",
        title: "Improvement run failed to start",
        message: String((error as Error)?.message || error),
        workspaceId: candidate.workspaceId,
      });
    }

    return this.runRepo.findById(run.id) || null;
  }

  private async finalizeRun(runId: string, taskId: string): Promise<void> {
    const run = this.runRepo.findById(runId);
    if (!run) return;
    const task = this.taskRepo.findById(taskId);
    if (!task || !["completed", "failed", "cancelled"].includes(task.status)) {
      return;
    }

    const settings = this.getSettings();
    const baselineMetrics =
      run.baselineMetrics || this.evaluationService.snapshot(settings.evalWindowDays);
    const evaluation = this.evaluationService.evaluateRun({
      runId,
      taskId,
      baselineMetrics,
      evalWindowDays: settings.evalWindowDays,
    });

    this.runRepo.update(runId, {
      status:
        task.status === "cancelled"
          ? "cancelled"
          : evaluation.passed
            ? "passed"
            : "failed",
      completedAt: Date.now(),
      outcomeMetrics: evaluation.outcomeMetrics,
      verdictSummary: evaluation.summary,
      evaluationNotes: evaluation.notes.join("\n"),
    });

    if (evaluation.passed) {
      if (settings.reviewRequired) {
        this.candidateService.markCandidateReview(run.candidateId);
        void this.notify({
          type: "task_completed",
          title: "Improvement ready for review",
          message: evaluation.summary,
          taskId,
          workspaceId: run.workspaceId,
        });
      } else {
        await this.promoteRun(runId, taskId, "accepted");
      }
    } else {
      this.candidateService.reopenCandidate(run.candidateId);
      void this.notify({
        type: "task_failed",
        title: "Improvement experiment failed",
        message: evaluation.summary,
        taskId,
        workspaceId: run.workspaceId,
      });
    }
  }

  private async pickNextCandidate(requireWorktree: boolean): Promise<ImprovementCandidate | undefined> {
    const workspaces = this.workspaceRepo.findAll().filter((workspace) => !workspace.isTemp);
    const ranked: ImprovementCandidate[] = [];
    const worktreeManager = requireWorktree ? this.agentDaemon?.getWorktreeManager() : undefined;
    for (const workspace of workspaces) {
      if (worktreeManager) {
        const canUseWorktree = await worktreeManager.shouldUseWorktree(workspace.path, workspace.isTemp);
        if (!canUseWorktree) continue;
      }
      const candidate = this.candidateService.getTopCandidateForWorkspace(workspace.id);
      if (candidate) ranked.push(candidate);
    }
    ranked.sort((a, b) => b.priorityScore - a.priorityScore || b.lastSeenAt - a.lastSeenAt);
    return ranked[0];
  }

  private resetInterval(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }

    const settings = this.getSettings();
    if (!settings.enabled || !settings.autoRun) return;
    this.intervalHandle = setInterval(() => {
      void this.refreshCandidates().then(() => this.runNextExperiment());
    }, settings.intervalMinutes * 60 * 1000);
  }

  private buildPullRequestTitle(
    candidate: ImprovementCandidate | undefined,
    run: ImprovementRun,
  ): string {
    if (candidate?.title?.trim()) {
      return `Self-improvement: ${candidate.title.trim()}`;
    }
    return `Self-improvement run ${run.id.slice(0, 8)}`;
  }

  private buildPullRequestBody(
    candidate: ImprovementCandidate | undefined,
    run: ImprovementRun,
  ): string {
    const lines = [
      "## Summary",
      `- ${candidate?.summary?.trim() || run.verdictSummary || "Autonomous improvement run."}`,
      run.verdictSummary ? `- Evaluation: ${run.verdictSummary}` : "",
      candidate?.recurrenceCount ? `- Recurrence count: ${candidate.recurrenceCount}` : "",
      "",
      "## Context",
      `- Improvement run: ${run.id}`,
      run.taskId ? `- Task: ${run.taskId}` : "",
      run.branchName ? `- Branch: ${run.branchName}` : "",
      "",
      "## Notes",
      run.evaluationNotes || "Generated by Cowork self-improvement loop.",
    ].filter(Boolean);
    return lines.join("\n");
  }

  private async notify(params: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    workspaceId?: string;
  }): Promise<void> {
    try {
      await this.deps.notify?.(params);
    } catch (error) {
      console.error("[ImprovementLoopService] Failed to emit notification:", error);
    }
  }

}

import type Database from "better-sqlite3";
import { EvalService } from "../eval/EvalService";
import { TaskEventRepository, TaskRepository } from "../database/repositories";
import type {
  EvalBaselineMetrics,
  ImprovementRunEvaluation,
  Task,
} from "../../shared/types";

export class ExperimentEvaluationService {
  private readonly evalService: EvalService;
  private readonly taskRepo: TaskRepository;
  private readonly eventRepo: TaskEventRepository;

  constructor(private readonly db: Database.Database) {
    this.evalService = new EvalService(db);
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new TaskEventRepository(db);
  }

  snapshot(windowDays: number): EvalBaselineMetrics {
    return this.evalService.getBaselineMetrics(windowDays);
  }

  evaluateRun(params: {
    runId: string;
    taskId: string;
    baselineMetrics: EvalBaselineMetrics;
    evalWindowDays: number;
  }): ImprovementRunEvaluation {
    const task = this.taskRepo.findById(params.taskId);
    if (!task) {
      const outcome = this.snapshot(params.evalWindowDays);
      return {
        runId: params.runId,
        passed: false,
        summary: "Experiment task could not be found for evaluation.",
        notes: ["The improvement task record was missing."],
        targetedVerificationPassed: false,
        verificationPassed: false,
        baselineMetrics: params.baselineMetrics,
        outcomeMetrics: outcome,
      };
    }

    const events = this.eventRepo.findByTaskId(task.id);
    const verificationPassed = events.some(
      (event) => event.legacyType === "verification_passed" || event.type === "verification_passed",
    );
    const verificationFailed = events.some(
      (event) => event.legacyType === "verification_failed" || event.type === "verification_failed",
    );
    const reviewFailed = events.some(
      (event) => event.legacyType === "review_quality_failed" || event.type === "review_quality_failed",
    );

    const targetedVerificationPassed = this.computeTargetedPass(task, verificationFailed, reviewFailed);
    const outcomeMetrics = this.snapshot(params.evalWindowDays);
    const notes = this.buildNotes(task, verificationPassed, verificationFailed, reviewFailed);

    return {
      runId: params.runId,
      passed: targetedVerificationPassed,
      summary: targetedVerificationPassed
        ? "Experiment passed targeted checks and is ready for review."
        : "Experiment did not satisfy the promotion gate.",
      notes,
      targetedVerificationPassed,
      verificationPassed,
      baselineMetrics: params.baselineMetrics,
      outcomeMetrics,
    };
  }

  private computeTargetedPass(
    task: Task,
    verificationFailed: boolean,
    reviewFailed: boolean,
  ): boolean {
    if (task.status !== "completed") return false;
    if (task.terminalStatus === "failed") return false;
    if (verificationFailed || reviewFailed) return false;
    return task.terminalStatus === "ok" || task.terminalStatus === "partial_success";
  }

  private buildNotes(
    task: Task,
    verificationPassed: boolean,
    verificationFailed: boolean,
    reviewFailed: boolean,
  ): string[] {
    const notes: string[] = [];
    notes.push(`Task status: ${task.status}${task.terminalStatus ? ` (${task.terminalStatus})` : ""}`);
    if (task.failureClass) {
      notes.push(`Failure class: ${task.failureClass}`);
    }
    if (verificationPassed) {
      notes.push("A verification pass event was recorded.");
    }
    if (verificationFailed) {
      notes.push("A verification failure event was recorded.");
    }
    if (reviewFailed) {
      notes.push("A post-completion quality review failed.");
    }
    if (task.resultSummary) {
      notes.push(`Summary: ${task.resultSummary.slice(0, 500)}`);
    }
    return notes;
  }
}

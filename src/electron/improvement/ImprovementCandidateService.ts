import fs from "fs";
import path from "path";
import crypto from "crypto";
import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";
import type {
  ImprovementCandidate,
  ImprovementCandidateSource,
  ImprovementEvidence,
} from "../../shared/types";
import { ImprovementCandidateRepository } from "./ImprovementRepositories";
import { ImprovementSettingsManager } from "./ImprovementSettingsManager";

const RECENT_WINDOW_DAYS = 14;
const MAX_EVIDENCE_ITEMS = 8;

export class ImprovementCandidateService {
  private readonly candidateRepo: ImprovementCandidateRepository;
  private readonly taskRepo: TaskRepository;
  private readonly workspaceRepo: WorkspaceRepository;
  private started = false;

  constructor(private readonly db: Database.Database) {
    this.candidateRepo = new ImprovementCandidateRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
  }

  async start(agentDaemon: AgentDaemon): Promise<void> {
    if (this.started) return;
    this.started = true;

    agentDaemon.on("task_completed", (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      void this.ingestTaskFailureCandidate(taskId);
    });

    agentDaemon.on("verification_failed", (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      void this.ingestEventCandidate(taskId, "verification_failure", evt);
    });

    agentDaemon.on("safety_stop_triggered", (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      void this.ingestEventCandidate(taskId, "task_failure", evt);
    });

    agentDaemon.on("user_feedback", (evt: Any) => {
      const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
      if (!taskId) return;
      void this.ingestFeedbackCandidate(taskId, evt);
    });

    await this.refresh();
  }

  async refresh(): Promise<{ candidateCount: number }> {
    await this.rebuildFromRecentSignals();
    await this.ingestDevLogs();
    return {
      candidateCount: this.listCandidates().length,
    };
  }

  listCandidates(workspaceId?: string): ImprovementCandidate[] {
    return this.candidateRepo.list({ workspaceId });
  }

  dismissCandidate(candidateId: string): ImprovementCandidate | undefined {
    const existing = this.candidateRepo.findById(candidateId);
    if (!existing) return undefined;
    this.candidateRepo.update(candidateId, {
      status: "dismissed",
      resolvedAt: Date.now(),
    });
    return this.candidateRepo.findById(candidateId);
  }

  markCandidateRunning(candidateId: string): void {
    this.candidateRepo.update(candidateId, {
      status: "running",
      lastExperimentAt: Date.now(),
    });
  }

  markCandidateReview(candidateId: string): void {
    this.candidateRepo.update(candidateId, {
      status: "review",
      resolvedAt: Date.now(),
    });
  }

  markCandidateResolved(candidateId: string): void {
    this.candidateRepo.update(candidateId, {
      status: "resolved",
      resolvedAt: Date.now(),
    });
  }

  reopenCandidate(candidateId: string): void {
    this.candidateRepo.update(candidateId, {
      status: "open",
      resolvedAt: null as Any,
    });
  }

  getTopCandidateForWorkspace(workspaceId: string): ImprovementCandidate | undefined {
    const settings = ImprovementSettingsManager.loadSettings();
    return this.candidateRepo.getTopRunnableCandidate(
      workspaceId,
      settings.maxOpenCandidatesPerWorkspace,
    );
  }

  private async rebuildFromRecentSignals(): Promise<void> {
    const since = Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const recentTasks = this.db
      .prepare(
        `
        SELECT id
        FROM tasks
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT 300
      `,
      )
      .all(since) as Array<{ id: string }>;

    for (const task of recentTasks) {
      await this.ingestTaskFailureCandidate(task.id);
    }

    const eventRows = this.db
      .prepare(
        `
        SELECT task_id, type, payload, id, timestamp
        FROM task_events
        WHERE timestamp >= ?
          AND COALESCE(legacy_type, type) IN ('verification_failed', 'safety_stop_triggered', 'user_feedback')
        ORDER BY timestamp DESC
        LIMIT 400
      `,
      )
      .all(since) as Any[];

    for (const row of eventRows) {
      const taskId = typeof row.task_id === "string" ? row.task_id : "";
      if (!taskId) continue;
      const payload = this.parsePayload(row.payload);
      const effectiveType = typeof row.type === "string" ? row.type : "";
      if (effectiveType === "user_feedback") {
        await this.ingestFeedbackCandidate(taskId, payload);
      } else if (effectiveType === "verification_failed") {
        await this.ingestEventCandidate(taskId, "verification_failure", {
          ...payload,
          eventId: row.id,
          timestamp: row.timestamp,
        });
      } else {
        await this.ingestEventCandidate(taskId, "task_failure", {
          ...payload,
          eventId: row.id,
          timestamp: row.timestamp,
        });
      }
    }
  }

  private async ingestTaskFailureCandidate(taskId: string): Promise<void> {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.source === "improvement") return;
    if (task.status !== "failed" && task.terminalStatus !== "failed" && task.terminalStatus !== "partial_success") {
      return;
    }

    const failureClass = String(task.failureClass || "unknown");
    const summary =
      typeof task.resultSummary === "string" && task.resultSummary.trim()
        ? task.resultSummary.trim()
        : task.error
          ? String(task.error)
          : `Task ended with ${failureClass}`;
    const evidence: ImprovementEvidence = {
      type: "task_failure",
      taskId: task.id,
      summary: this.truncate(summary),
      details: this.truncate(task.prompt, 800),
      createdAt: Date.now(),
      metadata: {
        failureClass,
        terminalStatus: task.terminalStatus,
        title: task.title,
      },
    };

    this.upsertCandidate(task.workspaceId, {
      source: "task_failure",
      title: `Fix repeated ${failureClass.replace(/_/g, " ")} failures`,
      summary: this.truncate(summary),
      evidence,
      lastTaskId: task.id,
      lastEventType: "task_completed",
      severity: this.inferTaskSeverity(task.failureClass, task.terminalStatus),
      fixabilityScore: this.inferFixabilityScore("task_failure", summary),
    });
  }

  private async ingestEventCandidate(
    taskId: string,
    source: ImprovementCandidateSource,
    payload: Any,
  ): Promise<void> {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.source === "improvement") return;

    const summary =
      typeof payload?.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : typeof payload?.verdict === "string" && payload.verdict.trim()
          ? payload.verdict.trim()
          : `Task ${task.title} triggered ${source}`;
    const evidence: ImprovementEvidence = {
      type: source,
      taskId: task.id,
      eventType: source === "verification_failure" ? "verification_failed" : "safety_stop_triggered",
      eventId: typeof payload?.eventId === "string" ? payload.eventId : undefined,
      summary: this.truncate(summary),
      details:
        typeof payload?.verdict === "string"
          ? this.truncate(payload.verdict, 1000)
          : typeof payload?.message === "string"
            ? this.truncate(payload.message, 1000)
            : undefined,
      createdAt: typeof payload?.timestamp === "number" ? payload.timestamp : Date.now(),
      metadata: {
        title: task.title,
      },
    };

    this.upsertCandidate(task.workspaceId, {
      source,
      title:
        source === "verification_failure"
          ? "Fix verifier-detected regressions"
          : "Fix safety-stop and no-progress loops",
      summary: this.truncate(summary),
      evidence,
      lastTaskId: task.id,
      lastEventType: evidence.eventType,
      severity: source === "verification_failure" ? 0.95 : 0.72,
      fixabilityScore: this.inferFixabilityScore(source, summary),
    });
  }

  private async ingestFeedbackCandidate(taskId: string, payload: Any): Promise<void> {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.source === "improvement") return;

    const decision = typeof payload?.decision === "string" ? payload.decision.trim() : "";
    const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
    if ((decision !== "rejected" && decision !== "edit") || !reason) {
      return;
    }

    const evidence: ImprovementEvidence = {
      type: "user_feedback",
      taskId: task.id,
      eventType: "user_feedback",
      summary: this.truncate(reason),
      details: this.truncate(task.resultSummary || task.prompt, 900),
      createdAt: Date.now(),
      metadata: {
        decision,
        title: task.title,
      },
    };

    this.upsertCandidate(task.workspaceId, {
      source: "user_feedback",
      title: "Fix issues repeatedly flagged by the user",
      summary: this.truncate(reason),
      evidence,
      lastTaskId: task.id,
      lastEventType: "user_feedback",
      severity: decision === "rejected" ? 0.9 : 0.75,
      fixabilityScore: this.inferFixabilityScore("user_feedback", reason),
    });
  }

  private async ingestDevLogs(): Promise<void> {
    const settings = ImprovementSettingsManager.loadSettings();
    if (!settings.includeDevLogs) return;

    for (const workspace of this.workspaceRepo.findAll()) {
      const logPath = path.join(workspace.path, "logs", "dev-latest.log");
      if (!fs.existsSync(logPath)) continue;
      let content = "";
      try {
        content = fs.readFileSync(logPath, "utf8");
      } catch {
        continue;
      }
      const lines = content
        .split(/\r?\n/)
        .filter((line) => /error|exception|failed|uncaught/i.test(line))
        .slice(-8);
      if (lines.length === 0) continue;
      const summary = lines[lines.length - 1].trim();
      const evidence: ImprovementEvidence = {
        type: "dev_log",
        summary: this.truncate(summary),
        details: this.truncate(lines.join("\n"), 1200),
        createdAt: Date.now(),
        metadata: {
          logPath,
        },
      };
      this.upsertCandidate(workspace.id, {
        source: "dev_log",
        title: "Investigate recurring dev log errors",
        summary: this.truncate(summary),
        evidence,
        severity: 0.78,
        fixabilityScore: this.inferFixabilityScore("dev_log", summary),
      });
    }
  }

  private upsertCandidate(
    workspaceId: string,
    input: {
      source: ImprovementCandidateSource;
      title: string;
      summary: string;
      evidence: ImprovementEvidence;
      lastTaskId?: string;
      lastEventType?: string;
      severity: number;
      fixabilityScore: number;
    },
  ): ImprovementCandidate {
    const fingerprint = this.buildFingerprint(input.source, input.summary);
    const existing = this.candidateRepo.findByFingerprint(workspaceId, fingerprint);
    const nextPriority = this.computePriorityScore(
      input.severity,
      (existing?.recurrenceCount || 0) + 1,
      input.fixabilityScore,
    );

    if (existing) {
      const duplicateEvidence = existing.evidence.some(
        (item) => this.getEvidenceKey(item) === this.getEvidenceKey(input.evidence),
      );
      if (duplicateEvidence) {
        return existing;
      }
      const evidence = [...existing.evidence, input.evidence]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-MAX_EVIDENCE_ITEMS);
      const nextStatus =
        existing.status === "dismissed"
          ? "dismissed"
          : existing.status === "running" || existing.status === "review"
            ? existing.status
            : "open";
      this.candidateRepo.update(existing.id, {
        status: nextStatus,
        title: input.title,
        summary: input.summary,
        severity: Math.max(existing.severity, input.severity),
        recurrenceCount: existing.recurrenceCount + 1,
        fixabilityScore: Math.max(existing.fixabilityScore, input.fixabilityScore),
        priorityScore: nextPriority,
        evidence,
        lastTaskId: input.lastTaskId || existing.lastTaskId,
        lastEventType: input.lastEventType || existing.lastEventType,
        lastSeenAt: input.evidence.createdAt,
        resolvedAt: nextStatus === "open" ? undefined : existing.resolvedAt,
      });
      return this.candidateRepo.findById(existing.id)!;
    }

    return this.candidateRepo.create({
      workspaceId,
      fingerprint,
      source: input.source,
      status: "open",
      title: input.title,
      summary: input.summary,
      severity: input.severity,
      recurrenceCount: 1,
      fixabilityScore: input.fixabilityScore,
      priorityScore: nextPriority,
      evidence: [input.evidence],
      lastTaskId: input.lastTaskId,
      lastEventType: input.lastEventType,
    });
  }

  private buildFingerprint(source: ImprovementCandidateSource, summary: string): string {
    const normalized = summary.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 220);
    return crypto.createHash("sha1").update(`${source}:${normalized}`).digest("hex");
  }

  private computePriorityScore(severity: number, recurrenceCount: number, fixabilityScore: number): number {
    return Number((severity * 0.55 + Math.min(1, recurrenceCount / 5) * 0.25 + fixabilityScore * 0.2).toFixed(4));
  }

  private inferFixabilityScore(source: ImprovementCandidateSource, summary: string): number {
    const normalized = summary.toLowerCase();
    if (/test|repro|stack|trace|contract|verification|assert/.test(normalized)) return 0.95;
    if (source === "user_feedback") return 0.72;
    if (source === "dev_log") return 0.8;
    return 0.85;
  }

  private inferTaskSeverity(
    failureClass?: string | null,
    terminalStatus?: string,
  ): number {
    if (/required_verification|contract_error|required_contract/i.test(String(failureClass || ""))) {
      return 0.9;
    }
    if (terminalStatus === "failed") return 0.82;
    if (terminalStatus === "partial_success") return 0.62;
    return 0.7;
  }

  private parsePayload(payload: unknown): Record<string, unknown> {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
    if (typeof payload !== "string") {
      return {};
    }
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private truncate(value: string, max = 280): string {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
  }

  private getEvidenceKey(evidence: ImprovementEvidence): string {
    return [
      evidence.type,
      evidence.taskId || "",
      evidence.eventId || "",
      evidence.eventType || "",
      evidence.summary,
    ].join("|");
  }
}

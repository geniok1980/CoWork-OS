import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import type { TaskEvent } from "../../shared/types";

export interface TranscriptSpanRecord {
  taskId: string;
  timestamp: number;
  type: string;
  payload: unknown;
  eventId?: string;
  seq?: number;
}

export interface TranscriptSearchResult {
  taskId: string;
  timestamp: number;
  type: string;
  payload: unknown;
  eventId?: string;
  seq?: number;
  rawLine: string;
}

export interface TranscriptCheckpointPayload {
  conversationHistory?: unknown[];
  trackerState?: unknown;
  planSummary?: unknown;
  explicitChatSummaryBlock?: string;
  explicitChatSummaryCreatedAt?: number;
  explicitChatSummarySourceMessageCount?: number;
  usageTotals?: unknown;
  timestamp?: number;
  messageCount?: number;
  sourceEventId?: string;
  sourceTimestamp?: number;
  resumeStrategy?: "snapshot" | "checkpoint" | "transcript";
}

function rootDir(workspacePath: string): string {
  return path.join(workspacePath, ".cowork", "memory", "transcripts");
}

function spansDir(workspacePath: string): string {
  return path.join(rootDir(workspacePath), "spans");
}

function checkpointsDir(workspacePath: string): string {
  return path.join(rootDir(workspacePath), "checkpoints");
}

function taskSpanPath(workspacePath: string, taskId: string): string {
  return path.join(spansDir(workspacePath), `${taskId}.jsonl`);
}

function taskCheckpointPath(workspacePath: string, taskId: string): string {
  return path.join(checkpointsDir(workspacePath), `${taskId}.json`);
}

function shouldPersistSpan(type: string): boolean {
  return [
    "task_created",
    "assistant_message",
    "timeline_group_started",
    "timeline_group_finished",
    "timeline_step_started",
    "timeline_step_updated",
    "timeline_step_finished",
    "timeline_evidence_attached",
    "timeline_artifact_emitted",
    "timeline_command_output",
    "timeline_error",
    "tool_call",
    "tool_result",
    "tool_error",
    "task_completed",
    "task_status",
    "task_paused",
    "task_resumed",
    "conversation_snapshot",
  ].includes(type);
}

function safeParseLine(line: string): TranscriptSpanRecord | null {
  try {
    const parsed = JSON.parse(line) as TranscriptSpanRecord;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.taskId !== "string" || typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export class TranscriptStore {
  static async ensureLayout(workspacePath: string): Promise<void> {
    await Promise.all([
      fs.mkdir(spansDir(workspacePath), { recursive: true }),
      fs.mkdir(checkpointsDir(workspacePath), { recursive: true }),
    ]);
  }

  static async appendEvent(workspacePath: string, event: TaskEvent): Promise<void> {
    if (!workspacePath || !shouldPersistSpan(event.type)) {
      return;
    }
    await this.ensureLayout(workspacePath);
    const record: TranscriptSpanRecord = {
      taskId: event.taskId,
      timestamp: typeof event.ts === "number" ? event.ts : event.timestamp,
      type: event.type,
      payload: event.payload,
      ...(event.eventId ? { eventId: event.eventId } : {}),
      ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
    };
    await fs.appendFile(taskSpanPath(workspacePath, event.taskId), `${JSON.stringify(record)}\n`, "utf8");
  }

  static async writeCheckpoint(
    workspacePath: string,
    taskId: string,
    checkpoint: TranscriptCheckpointPayload,
  ): Promise<void> {
    if (!workspacePath || !taskId) return;
    await this.ensureLayout(workspacePath);
    const payload = {
      ...checkpoint,
      timestamp: checkpoint.timestamp ?? Date.now(),
      resumeStrategy: checkpoint.resumeStrategy ?? "checkpoint",
    };
    await fs.writeFile(taskCheckpointPath(workspacePath, taskId), JSON.stringify(payload, null, 2), "utf8");
  }

  static async loadCheckpoint(
    workspacePath: string,
    taskId: string,
  ): Promise<TranscriptCheckpointPayload | null> {
    try {
      const raw = await fs.readFile(taskCheckpointPath(workspacePath, taskId), "utf8");
      const parsed = JSON.parse(raw) as TranscriptCheckpointPayload;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  static loadCheckpointSync(
    workspacePath: string,
    taskId: string,
  ): TranscriptCheckpointPayload | null {
    try {
      const raw = fsSync.readFileSync(taskCheckpointPath(workspacePath, taskId), "utf8");
      const parsed = JSON.parse(raw) as TranscriptCheckpointPayload;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  static async loadRecentSpans(
    workspacePath: string,
    taskId: string,
    limit = 40,
  ): Promise<TranscriptSpanRecord[]> {
    try {
      const raw = await fs.readFile(taskSpanPath(workspacePath, taskId), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => safeParseLine(line))
        .filter((entry): entry is TranscriptSpanRecord => entry !== null)
        .slice(-Math.max(1, limit));
    } catch {
      return [];
    }
  }

  static async searchSpans(params: {
    workspacePath: string;
    query: string;
    taskId?: string;
    limit?: number;
  }): Promise<TranscriptSearchResult[]> {
    const query = params.query.trim().toLowerCase();
    if (!query) return [];

    const limit = Math.max(1, params.limit ?? 10);
    const results: TranscriptSearchResult[] = [];
    const files = params.taskId
      ? [taskSpanPath(params.workspacePath, params.taskId)]
      : (await fs.readdir(spansDir(params.workspacePath)).catch(() => []))
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => path.join(spansDir(params.workspacePath), name));

    for (const file of files) {
      if (results.length >= limit) break;
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      if (!raw) continue;
      const lines = raw.split("\n").filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.toLowerCase().includes(query)) continue;
        const parsed = safeParseLine(line);
        if (!parsed) continue;
        results.push({ ...parsed, rawLine: line });
        if (results.length >= limit) break;
      }
    }

    return results;
  }
}

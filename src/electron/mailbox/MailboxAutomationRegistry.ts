import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getCronService } from "../cron";
import type { CronEvent, CronJobCreate, CronJobPatch } from "../cron/types";
import type { EventTriggerService } from "../triggers/EventTriggerService";
import type { EventTrigger, TriggerCondition, TriggerEvent, TriggerHistoryEntry } from "../triggers/types";
import type {
  MailboxAutomationRecord,
  MailboxAutomationStatus,
  MailboxRuleRecipe,
  MailboxScheduleRecipe,
} from "../../shared/mailbox";

type MailboxAutomationAuditEvent =
  | "created"
  | "updated"
  | "deleted"
  | "trigger_fired"
  | "cron_added"
  | "cron_updated"
  | "cron_started"
  | "cron_finished"
  | "cron_removed";

type MailboxAutomationRegistryDeps = {
  db: Database.Database;
  triggerService?: EventTriggerService | null;
  resolveDefaultWorkspaceId: () => string | undefined;
  log?: (...args: unknown[]) => void;
};

type MailboxAutomationRow = {
  id: string;
  workspace_id: string;
  kind: MailboxAutomationRecord["kind"];
  status: MailboxAutomationStatus;
  name: string;
  description: string | null;
  thread_id: string | null;
  source: MailboxAutomationRecord["source"];
  recipe_json: string;
  backing_trigger_id: string | null;
  backing_cron_job_id: string | null;
  latest_outcome: string | null;
  latest_fire_at: number | null;
  latest_run_at: number | null;
  next_run_at: number | null;
  latest_error: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxAutomationAuditRow = {
  id: string;
  automation_id: string;
  workspace_id: string;
  event_type: MailboxAutomationAuditEvent;
  detail_json: string;
  created_at: number;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function ruleTriggerName(recipe: MailboxRuleRecipe): string {
  return recipe.name.trim();
}

function scheduleJobName(recipe: MailboxScheduleRecipe): string {
  return recipe.name.trim();
}

export class MailboxAutomationRegistry {
  private static deps: MailboxAutomationRegistryDeps | null = null;

  static configure(deps: MailboxAutomationRegistryDeps): void {
    this.deps = deps;
    this.ensureSchema();
  }

  static reset(): void {
    this.deps = null;
  }

  static listAutomations(input?: { workspaceId?: string; threadId?: string }): MailboxAutomationRecord[] {
    const deps = this.getDeps();
    const conditions: string[] = ["status != 'deleted'"];
    const values: unknown[] = [];
    if (input?.workspaceId) {
      conditions.push("workspace_id = ?");
      values.push(input.workspaceId);
    }
    if (input?.threadId) {
      conditions.push("(thread_id = ? OR thread_id IS NULL)");
      values.push(input.threadId);
    }

    const rows = deps.db
      .prepare(
        `SELECT
           id,
           workspace_id,
           kind,
           status,
           name,
           description,
           thread_id,
           source,
           recipe_json,
           backing_trigger_id,
           backing_cron_job_id,
           latest_outcome,
           latest_fire_at,
           latest_run_at,
           next_run_at,
           latest_error,
           created_at,
           updated_at
         FROM mailbox_automations
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY updated_at DESC`,
      )
      .all(...values) as MailboxAutomationRow[];

    return rows.map((row) => this.enrichRecord(row));
  }

  static listThreadAutomations(threadId: string): MailboxAutomationRecord[] {
    return this.listAutomations({ threadId });
  }

  static listAutomationHistory(automationId: string, limit = 25): MailboxAutomationAuditRow[] {
    const deps = this.getDeps();
    return deps.db
      .prepare(
        `SELECT id, automation_id, workspace_id, event_type, detail_json, created_at
         FROM mailbox_automation_audit
         WHERE automation_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(automationId, Math.min(Math.max(limit, 1), 100)) as MailboxAutomationAuditRow[];
  }

  static createRule(recipe: MailboxRuleRecipe): MailboxAutomationRecord {
    const deps = this.getDeps();
    const workspaceId = recipe.workspaceId?.trim() || deps.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      throw new Error("No default workspace available for mailbox automation");
    }
    const triggerService = deps.triggerService;
    if (!triggerService) {
      throw new Error("Trigger service is not available");
    }
    if (recipe.actionType === "wake_agent" && !recipe.agentRoleId?.trim()) {
      throw new Error("Missing agentRoleId for wake_agent rule");
    }

    const automationId = randomUUID();
    const now = Date.now();
    const trigger = triggerService.addTrigger({
      name: ruleTriggerName(recipe),
      description: recipe.description,
      enabled: recipe.enabled ?? true,
      source: recipe.source || "mailbox_event",
      conditions: recipe.conditions as TriggerCondition[],
      conditionLogic: recipe.conditionLogic || "all",
      action: recipe.actionType === "wake_agent"
        ? {
            type: "wake_agent",
            config: {
              agentRoleId: recipe.agentRoleId || "",
              prompt: recipe.actionPrompt,
            },
          }
        : {
            type: "create_task",
            config: {
              title: recipe.actionTitle || recipe.name,
              prompt: recipe.actionPrompt,
              workspaceId,
            },
          },
      workspaceId,
      cooldownMs: recipe.cooldownMs,
    });

    const record: MailboxAutomationRecord = {
      id: automationId,
      workspaceId,
      kind: "rule",
      status: recipe.enabled === false ? "paused" : "active",
      name: recipe.name,
      description: recipe.description,
      threadId: recipe.threadId,
      source: "mailbox_event",
      rule: { ...recipe, source: "mailbox_event" },
      backingTriggerId: trigger.id,
      createdAt: now,
      updatedAt: now,
    };

    this.insertRecord(record, {
      automationId,
      workspaceId,
      eventType: "created",
      detail: { kind: "rule", triggerId: trigger.id },
    });
    const created = this.fetchRow(automationId);
    if (!created) {
      throw new Error("Failed to persist mailbox rule");
    }
    return this.enrichRecord(created);
  }

  static updateRule(
    automationId: string,
    patch: Partial<MailboxRuleRecipe> & { status?: MailboxAutomationStatus },
  ): MailboxAutomationRecord | null {
    const deps = this.getDeps();
    const row = this.fetchRow(automationId);
    if (!row || row.kind !== "rule") return null;

    const record = this.enrichRecord(row);
    const nextRule = {
      ...(record.rule || { name: record.name, conditions: [], actionType: "create_task", actionPrompt: "" }),
      ...patch,
      source: "mailbox_event" as const,
    };
    const triggerService = deps.triggerService;
    if (record.backingTriggerId && triggerService) {
      const existing = triggerService.getTrigger(record.backingTriggerId);
      if (existing) {
        triggerService.updateTrigger(record.backingTriggerId, {
          name: nextRule.name ?? record.name,
          description: nextRule.description ?? record.description,
          enabled: patch.status ? patch.status === "active" : existing.enabled,
          source: "mailbox_event",
          conditions: nextRule.conditions as TriggerCondition[],
          conditionLogic: nextRule.conditionLogic || "all",
          cooldownMs: nextRule.cooldownMs ?? existing.cooldownMs,
          action:
            nextRule.actionType === "wake_agent"
              ? {
                  type: "wake_agent",
                  config: {
                    agentRoleId: nextRule.agentRoleId || "",
                    prompt: nextRule.actionPrompt,
                  },
                }
              : {
                  type: "create_task",
                  config: {
                    title: nextRule.actionTitle || nextRule.name,
                    prompt: nextRule.actionPrompt,
                    workspaceId: record.workspaceId,
                  },
                },
        });
      }
    }

    const now = Date.now();
    const nextStatus = patch.status ?? record.status;
    deps.db
      .prepare(
        `UPDATE mailbox_automations
         SET name = ?, description = ?, status = ?, thread_id = ?, recipe_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        normalizeString(nextRule.name) || record.name,
        nextRule.description || null,
        nextStatus,
        nextRule.threadId || null,
        stringifyJson(nextRule),
        now,
        automationId,
      );
    this.appendAudit(automationId, record.workspaceId, "updated", { patch });
    return this.listAutomations({ workspaceId: record.workspaceId }).find((item) => item.id === automationId) ?? null;
  }

  static deleteRule(automationId: string): boolean {
    const deps = this.getDeps();
    const row = this.fetchRow(automationId);
    if (!row || row.kind !== "rule") return false;
    const record = this.enrichRecord(row);
    if (record.backingTriggerId && deps.triggerService) {
      deps.triggerService.removeTrigger(record.backingTriggerId);
    }
    this.markDeleted(record.id, record.workspaceId, { backingTriggerId: record.backingTriggerId });
    return true;
  }

  static async createSchedule(recipe: MailboxScheduleRecipe): Promise<MailboxAutomationRecord> {
    const deps = this.getDeps();
    const cron = getCronService();
    if (!cron) {
      throw new Error("Cron service is not available");
    }

    const workspaceId = recipe.workspaceId?.trim() || deps.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      throw new Error("No default workspace available for mailbox automation");
    }
    const automationId = randomUUID();
    const now = Date.now();
    const jobName = scheduleJobName(recipe);
    const descriptionParts = [
      recipe.description,
      `mailbox-automation:${automationId}`,
      recipe.threadId ? `thread:${recipe.threadId}` : undefined,
      `kind:${recipe.kind || "schedule"}`,
    ].filter((entry): entry is string => Boolean(entry));

    const jobResult = await cron.add({
      name: jobName,
      description: descriptionParts.join(" · "),
      enabled: recipe.enabled ?? true,
      deleteAfterRun: recipe.kind === "reminder" && recipe.schedule.kind === "at",
      allowUserInput: false,
      shellAccess: false,
      schedule: recipe.schedule,
      workspaceId,
      taskTitle: recipe.taskTitle,
      taskPrompt: recipe.taskPrompt,
      maxHistoryEntries: 10,
    } satisfies CronJobCreate);

    if (!jobResult.ok) {
      throw new Error(jobResult.error);
    }

    return this.insertScheduleRecord({
      automationId,
      workspaceId,
      recipe,
      cronJobId: jobResult.job.id,
      status: recipe.enabled === false ? "paused" : "active",
      now,
      nextRunAt: jobResult.job.state.nextRunAtMs,
    });
  }

  static async updateSchedule(
    automationId: string,
    patch: Partial<MailboxScheduleRecipe> & { status?: MailboxAutomationStatus },
  ): Promise<MailboxAutomationRecord | null> {
    const deps = this.getDeps();
    const row = this.fetchRow(automationId);
    if (!row || row.kind !== "schedule" && row.kind !== "reminder") return null;
    const record = this.enrichRecord(row);
    const cron = getCronService();
    const recipe = {
      ...(record.schedule || {
        name: record.name,
        schedule: { kind: "at", atMs: Date.now() },
        taskTitle: record.name,
        taskPrompt: "",
      }),
      ...patch,
    } as MailboxScheduleRecipe;

    if (record.backingCronJobId && cron) {
      const existing = await cron.get(record.backingCronJobId);
      if (existing) {
        const patchJob: CronJobPatch = {
          name: recipe.name,
          description: recipe.description,
          enabled: patch.status ? patch.status === "active" : existing.enabled,
          schedule: recipe.schedule,
          workspaceId: recipe.workspaceId || existing.workspaceId,
          taskPrompt: recipe.taskPrompt,
          taskTitle: recipe.taskTitle,
        };
        await cron.update(record.backingCronJobId, patchJob);
      }
    }

    const now = Date.now();
    const nextStatus = patch.status ?? record.status;
    deps.db
      .prepare(
        `UPDATE mailbox_automations
         SET name = ?, description = ?, status = ?, thread_id = ?, recipe_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        normalizeString(recipe.name) || record.name,
        recipe.description || null,
        nextStatus,
        recipe.threadId || null,
        stringifyJson(recipe),
        now,
        automationId,
      );
    this.appendAudit(automationId, record.workspaceId, "updated", { patch });
    return this.listAutomations({ workspaceId: record.workspaceId }).find((item) => item.id === automationId) ?? null;
  }

  static async deleteSchedule(automationId: string): Promise<boolean> {
    const deps = this.getDeps();
    const row = this.fetchRow(automationId);
    if (!row || (row.kind !== "schedule" && row.kind !== "reminder")) return false;
    const record = this.enrichRecord(row);
    const cron = getCronService();
    if (record.backingCronJobId && cron) {
      await cron.remove(record.backingCronJobId);
    }
    this.markDeleted(record.id, record.workspaceId, { backingCronJobId: record.backingCronJobId });
    return true;
  }

  static recordTriggerFire(payload: {
    trigger: EventTrigger;
    event: TriggerEvent;
    historyEntry: TriggerHistoryEntry;
  }): void {
    const deps = this.getDeps();
    const row = deps.db
      .prepare(
        `SELECT * FROM mailbox_automations WHERE backing_trigger_id = ? LIMIT 1`,
      )
      .get(payload.trigger.id) as MailboxAutomationRow | undefined;
    if (!row) return;
    const now = Date.now();
    deps.db
      .prepare(
        `UPDATE mailbox_automations
         SET latest_outcome = ?, latest_fire_at = ?, latest_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(payload.historyEntry.actionResult || "fired", payload.historyEntry.firedAt, now, row.id);
    this.appendAudit(row.id, row.workspace_id, "trigger_fired", {
      triggerId: payload.trigger.id,
      actionResult: payload.historyEntry.actionResult,
      eventType: typeof payload.event.fields.eventType === "string"
        ? payload.event.fields.eventType
        : payload.event.source,
    });
  }

  static async recordCronEvent(evt: CronEvent): Promise<void> {
    const deps = this.getDeps();
    const row = deps.db
      .prepare(
        `SELECT * FROM mailbox_automations WHERE backing_cron_job_id = ? LIMIT 1`,
      )
      .get(evt.jobId) as MailboxAutomationRow | undefined;
    if (!row) return;
    const cron = getCronService();
    const jobPromise = cron?.get(evt.jobId);
    const job = jobPromise ? await jobPromise : null;

    const now = Date.now();
    if (evt.action === "removed") {
      deps.db
        .prepare(`UPDATE mailbox_automations SET status = ?, updated_at = ? WHERE id = ?`)
        .run("deleted", now, row.id);
      this.appendAudit(row.id, row.workspace_id, "cron_removed", { jobId: evt.jobId });
      return;
    }

    const latestOutcome =
      evt.action === "finished" ? evt.status || row.latest_outcome || null : row.latest_outcome;
    deps.db
      .prepare(
        `UPDATE mailbox_automations
         SET latest_outcome = ?, latest_run_at = COALESCE(?, latest_run_at), next_run_at = ?, latest_error = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        latestOutcome,
        evt.action === "started" ? evt.runAtMs ?? now : evt.action === "finished" ? evt.runAtMs ?? now : null,
        evt.nextRunAtMs ?? job?.state.nextRunAtMs ?? row.next_run_at,
        evt.error || null,
        evt.action === "finished" && evt.status === "error"
          ? "error"
          : job?.enabled === false
            ? "paused"
            : row.status === "deleted"
              ? "deleted"
              : "active",
        now,
        row.id,
      );
    const auditEvent: MailboxAutomationAuditEvent =
      evt.action === "started"
        ? "cron_started"
        : evt.action === "finished"
          ? "cron_finished"
          : evt.action === "added"
            ? "cron_added"
            : "cron_updated";
    this.appendAudit(row.id, row.workspace_id, auditEvent, {
      jobId: evt.jobId,
      status: evt.status,
      error: evt.error,
      taskId: evt.taskId,
    });
  }

  private static ensureSchema(): void {
    const deps = this.getDeps();
    deps.db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_automations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        thread_id TEXT,
        source TEXT NOT NULL,
        recipe_json TEXT NOT NULL,
        backing_trigger_id TEXT,
        backing_cron_job_id TEXT,
        latest_outcome TEXT,
        latest_fire_at INTEGER,
        latest_run_at INTEGER,
        next_run_at INTEGER,
        latest_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_workspace ON mailbox_automations(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_thread ON mailbox_automations(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_kind ON mailbox_automations(kind, status);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_trigger ON mailbox_automations(backing_trigger_id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_cron ON mailbox_automations(backing_cron_job_id);

      CREATE TABLE IF NOT EXISTS mailbox_automation_audit (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_automation_audit_automation
        ON mailbox_automation_audit(automation_id, created_at DESC);
    `);
  }

  private static getDeps(): MailboxAutomationRegistryDeps {
    if (!this.deps) {
      throw new Error("Mailbox automation registry is not configured");
    }
    return this.deps;
  }

  private static fetchRow(automationId: string): MailboxAutomationRow | undefined {
    const deps = this.getDeps();
    return deps.db
      .prepare(
        `SELECT
           id,
           workspace_id,
           kind,
           status,
           name,
           description,
           thread_id,
           source,
           recipe_json,
           backing_trigger_id,
           backing_cron_job_id,
           latest_outcome,
           latest_fire_at,
           latest_run_at,
           next_run_at,
           latest_error,
           created_at,
           updated_at
         FROM mailbox_automations
         WHERE id = ?`,
      )
      .get(automationId) as MailboxAutomationRow | undefined;
  }

  private static enrichRecord(row: MailboxAutomationRow): MailboxAutomationRecord {
    const recipe = parseJson<MailboxRuleRecipe | MailboxScheduleRecipe | Record<string, unknown>>(
      row.recipe_json,
      {},
    );
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      kind: row.kind,
      status:
        row.status === "deleted"
          ? "deleted"
          : row.status === "error"
            ? "error"
            : row.status === "paused"
              ? "paused"
              : "active",
      name: row.name,
      description: row.description || undefined,
      threadId: row.thread_id || undefined,
      source: row.source,
      rule:
        row.kind === "rule"
          ? (recipe as MailboxRuleRecipe)
          : undefined,
      schedule:
        row.kind === "schedule" || row.kind === "reminder"
          ? (recipe as MailboxScheduleRecipe)
          : undefined,
      backingTriggerId: row.backing_trigger_id || undefined,
      backingCronJobId: row.backing_cron_job_id || undefined,
      latestOutcome: row.latest_outcome || undefined,
      latestFireAt: row.latest_fire_at || undefined,
      latestRunAt: row.latest_run_at || undefined,
      nextRunAt: row.next_run_at || undefined,
      latestError: row.latest_error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static insertRecord(
    record: MailboxAutomationRecord,
    audit: { automationId: string; workspaceId: string; eventType: MailboxAutomationAuditEvent; detail: Record<string, unknown> },
  ): void {
    const deps = this.getDeps();
    deps.db
      .prepare(
        `INSERT INTO mailbox_automations
          (id, workspace_id, kind, status, name, description, thread_id, source, recipe_json, backing_trigger_id, backing_cron_job_id, latest_outcome, latest_fire_at, latest_run_at, next_run_at, latest_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.kind,
        record.status,
        record.name,
        record.description || null,
        record.threadId || null,
        record.source,
        stringifyJson(record.kind === "rule" ? record.rule || {} : record.schedule || {}),
        record.backingTriggerId || null,
        record.backingCronJobId || null,
        record.latestOutcome || null,
        record.latestFireAt || null,
        record.latestRunAt || null,
        record.nextRunAt || null,
        record.latestError || null,
        record.createdAt,
        record.updatedAt,
      );
    this.appendAudit(audit.automationId, audit.workspaceId, audit.eventType, audit.detail);
  }

  private static insertScheduleRecord(input: {
    automationId: string;
    workspaceId: string;
    recipe: MailboxScheduleRecipe;
    cronJobId?: string;
    status: MailboxAutomationStatus;
    now: number;
    nextRunAt?: number;
  }): MailboxAutomationRecord {
    const record: MailboxAutomationRecord = {
      id: input.automationId,
      workspaceId: input.workspaceId,
      kind: input.recipe.kind || (input.recipe.schedule.kind === "at" ? "reminder" : "schedule"),
      status: input.status,
      name: input.recipe.name,
      description: input.recipe.description,
      threadId: input.recipe.threadId,
      source: "cron",
      schedule: input.recipe,
      backingCronJobId: input.cronJobId,
      nextRunAt: input.nextRunAt ?? (input.recipe.schedule.kind === "at" ? input.recipe.schedule.atMs : undefined),
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.insertRecord(record, {
      automationId: record.id,
      workspaceId: record.workspaceId,
      eventType: "created",
      detail: { kind: record.kind, cronJobId: record.backingCronJobId },
    });
    const created = this.fetchRow(record.id);
    if (!created) {
      throw new Error("Failed to persist mailbox schedule");
    }
    return this.enrichRecord(created);
  }

  private static appendAudit(
    automationId: string,
    workspaceId: string,
    eventType: MailboxAutomationAuditEvent,
    detail: Record<string, unknown>,
  ): void {
    const deps = this.getDeps();
    deps.db
      .prepare(
        `INSERT INTO mailbox_automation_audit
          (id, automation_id, workspace_id, event_type, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), automationId, workspaceId, eventType, stringifyJson(detail), Date.now());
  }

  private static markDeleted(
    automationId: string,
    workspaceId: string,
    detail: Record<string, unknown>,
  ): void {
    const deps = this.getDeps();
    deps.db
      .prepare(
        `UPDATE mailbox_automations
         SET status = 'deleted', updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), automationId);
    this.appendAudit(automationId, workspaceId, "deleted", detail);
  }
}

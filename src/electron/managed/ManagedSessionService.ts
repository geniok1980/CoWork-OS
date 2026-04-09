import { randomUUID } from "crypto";
import type { AgentConfig, InputRequestResponse, ManagedSessionEventType } from "../../shared/types";
import type {
  ManagedAgent,
  ManagedAgentVersion,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionCreateInput,
  ManagedSessionEvent,
  ManagedSessionInputContent,
  ManagedSessionStatus,
  Task,
  TaskEvent,
} from "../../shared/types";
import { deriveCanonicalTaskStatus, isTerminalTaskStatus } from "../../shared/task-status";
import type { AgentDaemon } from "../agent/daemon";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { AgentTeamItemRepository } from "../agents/AgentTeamItemRepository";
import { AgentTeamMemberRepository } from "../agents/AgentTeamMemberRepository";
import { AgentTeamRepository } from "../agents/AgentTeamRepository";
import { AgentTeamRunRepository } from "../agents/AgentTeamRunRepository";
import {
  ArtifactRepository,
  InputRequestRepository,
  TaskEventRepository,
  TaskRepository,
  WorkspaceRepository,
} from "../database/repositories";
import { MCPSettingsManager } from "../mcp/settings";
import { ManagedAccountManager } from "../accounts/managed-account-manager";
import {
  ManagedAgentRepository,
  ManagedAgentVersionRepository,
  ManagedEnvironmentRepository,
  ManagedSessionEventRepository,
  ManagedSessionRepository,
} from "./repositories";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const MANAGED_EVENT_MAX_STRING_CHARS = 2000;
const MANAGED_EVENT_MAX_ARRAY_ITEMS = 50;
const MANAGED_EVENT_MAX_OBJECT_KEYS = 50;
const MANAGED_EVENT_MAX_DEPTH = 3;
const MANAGED_EVENT_SENSITIVE_KEY_RE = /(token|api[_-]?key|secret|password|authorization)/i;
const MANAGED_EVENT_ALWAYS_REDACT_KEY_RE = /^(prompt|systemPrompt)$/i;

export function sanitizeManagedEventPayload(value: unknown, depth = 0, key?: string): unknown {
  if (depth > MANAGED_EVENT_MAX_DEPTH) return "[... truncated ...]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const maxChars = key === "message" ? 12000 : MANAGED_EVENT_MAX_STRING_CHARS;
    if (value.length <= maxChars) return value;
    return value.slice(0, maxChars) + `\n\n[... truncated (${value.length} chars) ...]`;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const next = value
      .slice(0, MANAGED_EVENT_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeManagedEventPayload(item, depth + 1));
    if (value.length > MANAGED_EVENT_MAX_ARRAY_ITEMS) {
      next.push(`[... ${value.length - MANAGED_EVENT_MAX_ARRAY_ITEMS} more items truncated ...]`);
    }
    return next;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj);
    for (const nextKey of keys.slice(0, MANAGED_EVENT_MAX_OBJECT_KEYS)) {
      if (MANAGED_EVENT_ALWAYS_REDACT_KEY_RE.test(nextKey) || MANAGED_EVENT_SENSITIVE_KEY_RE.test(nextKey)) {
        out[nextKey] = "[REDACTED]";
        continue;
      }
      out[nextKey] = sanitizeManagedEventPayload(obj[nextKey], depth + 1, nextKey);
    }
    if (keys.length > MANAGED_EVENT_MAX_OBJECT_KEYS) {
      out.__truncated_keys__ = keys.length - MANAGED_EVENT_MAX_OBJECT_KEYS;
    }
    return out;
  }
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

function toManagedSessionStatus(task?: Task, hasPendingInput = false): ManagedSessionStatus {
  if (!task) return "failed";
  if (hasPendingInput) return "awaiting_input";
  switch (deriveCanonicalTaskStatus(task)) {
    case "pending":
    case "queued":
    case "planning":
      return "pending";
    case "paused":
    case "blocked":
      return "awaiting_input";
    case "executing":
      return "running";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

function mapTaskEventType(event: TaskEvent): ManagedSessionEventType {
  const effectiveType = event.legacyType || event.type;
  switch (effectiveType) {
    case "assistant_message":
      return "assistant.message";
    case "tool_call":
      return "tool.call";
    case "tool_result":
      return "tool.result";
    case "input_request_created":
      return "input.requested";
    case "task_completed":
      return "session.completed";
    case "task_status":
      return "status.changed";
    case "error":
      return "session.failed";
    default:
      return "task.event.bridge";
  }
}

function normalizeManagedSessionEventPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  return sanitizeManagedEventPayload(payload) as Record<string, unknown>;
}

export function resolveManagedAllowedMcpTools(
  environmentConfig: Pick<ManagedEnvironment["config"], "allowedMcpServerIds">,
): string[] {
  const serverIds = environmentConfig.allowedMcpServerIds || [];
  if (serverIds.length === 0) return [];
  const settings = MCPSettingsManager.loadSettings();
  const prefix = settings.toolNamePrefix || "mcp_";
  const out = new Set<string>();
  for (const serverId of serverIds) {
    const server = MCPSettingsManager.getServer(serverId);
    if (!server) {
      throw new Error(`Managed environment references unknown MCP server: ${serverId}`);
    }
    if (!Array.isArray(server.tools) || server.tools.length === 0) {
      throw new Error(
        `Managed environment requires MCP server "${serverId}" tool metadata, but none is available`,
      );
    }
    for (const tool of server.tools) {
      if (tool?.name) out.add(`${prefix}${tool.name}`);
    }
  }
  if (out.size === 0) {
    throw new Error("Managed environment MCP allowlist resolved to zero tools");
  }
  return Array.from(out);
}

export class ManagedSessionService {
  private readonly taskRepo: TaskRepository;
  private readonly taskEventRepo: TaskEventRepository;
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly artifactRepo: ArtifactRepository;
  private readonly inputRequestRepo: InputRequestRepository;
  private readonly managedAgentRepo: ManagedAgentRepository;
  private readonly managedAgentVersionRepo: ManagedAgentVersionRepository;
  private readonly managedEnvironmentRepo: ManagedEnvironmentRepository;
  private readonly managedSessionRepo: ManagedSessionRepository;
  private readonly managedSessionEventRepo: ManagedSessionEventRepository;
  private readonly teamRepo: AgentTeamRepository;
  private readonly teamMemberRepo: AgentTeamMemberRepository;
  private readonly teamRunRepo: AgentTeamRunRepository;
  private readonly teamItemRepo: AgentTeamItemRepository;
  private readonly agentRoleRepo: AgentRoleRepository;

  constructor(
    private readonly db: import("better-sqlite3").Database,
    private readonly agentDaemon: AgentDaemon,
  ) {
    this.taskRepo = new TaskRepository(db);
    this.taskEventRepo = new TaskEventRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.artifactRepo = new ArtifactRepository(db);
    this.inputRequestRepo = new InputRequestRepository(db);
    this.managedAgentRepo = new ManagedAgentRepository(db);
    this.managedAgentVersionRepo = new ManagedAgentVersionRepository(db);
    this.managedEnvironmentRepo = new ManagedEnvironmentRepository(db);
    this.managedSessionRepo = new ManagedSessionRepository(db);
    this.managedSessionEventRepo = new ManagedSessionEventRepository(db);
    this.teamRepo = new AgentTeamRepository(db);
    this.teamMemberRepo = new AgentTeamMemberRepository(db);
    this.teamRunRepo = new AgentTeamRunRepository(db);
    this.teamItemRepo = new AgentTeamItemRepository(db);
    this.agentRoleRepo = new AgentRoleRepository(db);
  }

  listAgents(params?: { limit?: number; offset?: number; status?: ManagedAgent["status"] }): ManagedAgent[] {
    return this.managedAgentRepo.list(params);
  }

  getAgent(agentId: string): { agent: ManagedAgent; currentVersion?: ManagedAgentVersion } | undefined {
    const agent = this.managedAgentRepo.findById(agentId);
    if (!agent) return undefined;
    return {
      agent,
      currentVersion: this.managedAgentVersionRepo.find(agentId, agent.currentVersion),
    };
  }

  createAgent(input: {
    name: string;
    description?: string;
    systemPrompt: string;
    executionMode: ManagedAgentVersion["executionMode"];
    model?: ManagedAgentVersion["model"];
    runtimeDefaults?: ManagedAgentVersion["runtimeDefaults"];
    skills?: string[];
    mcpServers?: string[];
    teamTemplate?: ManagedAgentVersion["teamTemplate"];
    metadata?: Record<string, unknown>;
  }): { agent: ManagedAgent; version: ManagedAgentVersion } {
    const id = randomUUID();
    const agent = this.managedAgentRepo.create({
      id,
      name: input.name,
      description: input.description,
      status: "active",
      currentVersion: 1,
    });
    const version: ManagedAgentVersion = {
      agentId: id,
      version: 1,
      model: input.model,
      systemPrompt: input.systemPrompt,
      executionMode: input.executionMode,
      runtimeDefaults: input.runtimeDefaults,
      skills: input.skills,
      mcpServers: input.mcpServers,
      teamTemplate: input.teamTemplate,
      metadata: input.metadata,
      createdAt: Date.now(),
    };
    this.managedAgentVersionRepo.create(version);
    return { agent, version };
  }

  updateAgent(
    agentId: string,
    input: {
      name?: string;
      description?: string;
      systemPrompt?: string;
      executionMode?: ManagedAgentVersion["executionMode"];
      model?: ManagedAgentVersion["model"];
      runtimeDefaults?: ManagedAgentVersion["runtimeDefaults"];
      skills?: string[];
      mcpServers?: string[];
      teamTemplate?: ManagedAgentVersion["teamTemplate"];
      metadata?: Record<string, unknown>;
    },
  ): { agent: ManagedAgent; version: ManagedAgentVersion } {
    const existing = this.managedAgentRepo.findById(agentId);
    if (!existing) throw new Error(`Managed agent not found: ${agentId}`);
    const currentVersion = this.managedAgentVersionRepo.find(agentId, existing.currentVersion);
    if (!currentVersion) {
      throw new Error(`Managed agent version missing: ${agentId}@${existing.currentVersion}`);
    }
    const nextVersion = existing.currentVersion + 1;
    const agent = this.managedAgentRepo.update(agentId, {
      name: input.name,
      description: input.description,
      currentVersion: nextVersion,
    });
    if (!agent) throw new Error(`Managed agent not found: ${agentId}`);
    const version: ManagedAgentVersion = {
      agentId,
      version: nextVersion,
      model: input.model ?? currentVersion.model,
      systemPrompt: input.systemPrompt ?? currentVersion.systemPrompt,
      executionMode: input.executionMode ?? currentVersion.executionMode,
      runtimeDefaults: input.runtimeDefaults ?? currentVersion.runtimeDefaults,
      skills: input.skills ?? currentVersion.skills,
      mcpServers: input.mcpServers ?? currentVersion.mcpServers,
      teamTemplate: input.teamTemplate ?? currentVersion.teamTemplate,
      metadata: input.metadata ?? currentVersion.metadata,
      createdAt: Date.now(),
    };
    this.managedAgentVersionRepo.create(version);
    return { agent, version };
  }

  archiveAgent(agentId: string): ManagedAgent | undefined {
    return this.managedAgentRepo.update(agentId, { status: "archived" });
  }

  listAgentVersions(agentId: string): ManagedAgentVersion[] {
    return this.managedAgentVersionRepo.list(agentId);
  }

  getAgentVersion(agentId: string, version: number): ManagedAgentVersion | undefined {
    return this.managedAgentVersionRepo.find(agentId, version);
  }

  listEnvironments(params?: {
    limit?: number;
    offset?: number;
    status?: ManagedEnvironment["status"];
  }): ManagedEnvironment[] {
    return this.managedEnvironmentRepo.list(params);
  }

  getEnvironment(environmentId: string): ManagedEnvironment | undefined {
    return this.managedEnvironmentRepo.findById(environmentId);
  }

  createEnvironment(input: {
    name: string;
    kind?: ManagedEnvironment["kind"];
    config: ManagedEnvironment["config"];
  }): ManagedEnvironment {
    if (!this.workspaceRepo.findById(input.config.workspaceId)) {
      throw new Error(`Workspace not found: ${input.config.workspaceId}`);
    }
    this.validateManagedAccountRefs(input.config.managedAccountRefs);
    return this.managedEnvironmentRepo.create({
      id: randomUUID(),
      name: input.name,
      kind: input.kind || "cowork_local",
      revision: 1,
      status: "active",
      config: input.config,
    });
  }

  updateEnvironment(
    environmentId: string,
    input: { name?: string; config?: ManagedEnvironment["config"] },
  ): ManagedEnvironment | undefined {
    const existing = this.managedEnvironmentRepo.findById(environmentId);
    if (!existing) return undefined;
    const nextConfig = input.config ? { ...existing.config, ...input.config } : undefined;
    if (nextConfig?.workspaceId && !this.workspaceRepo.findById(nextConfig.workspaceId)) {
      throw new Error(`Workspace not found: ${nextConfig.workspaceId}`);
    }
    this.validateManagedAccountRefs(nextConfig?.managedAccountRefs);
    return this.managedEnvironmentRepo.update(environmentId, {
      name: input.name,
      config: nextConfig,
      revision: existing.revision + 1,
    });
  }

  archiveEnvironment(environmentId: string): ManagedEnvironment | undefined {
    return this.managedEnvironmentRepo.update(environmentId, { status: "archived" });
  }

  async createSession(input: ManagedSessionCreateInput): Promise<ManagedSession> {
    const agent = this.managedAgentRepo.findById(input.agentId);
    if (!agent) throw new Error(`Managed agent not found: ${input.agentId}`);
    const version = this.managedAgentVersionRepo.find(agent.id, agent.currentVersion);
    if (!version) throw new Error(`Managed agent version missing: ${agent.id}@${agent.currentVersion}`);
    const environment = this.managedEnvironmentRepo.findById(input.environmentId);
    if (!environment) throw new Error(`Managed environment not found: ${input.environmentId}`);
    const workspace = this.workspaceRepo.findById(environment.config.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${environment.config.workspaceId}`);

    const now = Date.now();
    const userPrompt = this.materializeContent(input.initialEvent?.content || []);
    const effectivePrompt = this.composeRootPrompt(version, userPrompt);
    const baseAgentConfig = this.buildAgentConfig(environment, version);

    if (version.executionMode === "team") {
      const task = this.taskRepo.create({
        title: input.title,
        prompt: effectivePrompt,
        rawPrompt: effectivePrompt,
        userPrompt: userPrompt || effectivePrompt,
        status: "pending",
        workspaceId: environment.config.workspaceId,
        agentConfig: baseAgentConfig,
      });

      const { teamRunId } = await this.createManagedTeamRun(task, agent, version);
      const session = this.managedSessionRepo.create({
        id: randomUUID(),
        agentId: agent.id,
        agentVersion: version.version,
        environmentId: environment.id,
        title: input.title,
        status: "running",
        workspaceId: environment.config.workspaceId,
        backingTaskId: task.id,
        backingTeamRunId: teamRunId,
        latestSummary: undefined,
        startedAt: now,
      });
      this.managedSessionEventRepo.create({
        sessionId: session.id,
        timestamp: now,
        type: "session.created",
        payload: {
          agentId: agent.id,
          agentVersion: version.version,
          environmentId: environment.id,
          backingTaskId: task.id,
          backingTeamRunId: teamRunId,
        },
      });
      if (input.initialEvent?.type === "user.message") {
        this.managedSessionEventRepo.create({
          sessionId: session.id,
          timestamp: now,
          type: "user.message",
          payload: { content: input.initialEvent.content },
        });
      }
      try {
        await this.agentDaemon.startTask(task);
      } catch (error: Any) {
        const message = error?.message || "Failed to start managed team session";
        this.teamRunRepo.update(teamRunId, { status: "failed", error: message });
        this.agentDaemon.failTask(task.id, message, {
          resultSummary: message,
        });
        this.managedSessionRepo.update(session.id, {
          status: "failed",
          latestSummary: message,
          completedAt: Date.now(),
        });
        this.managedSessionEventRepo.create({
          sessionId: session.id,
          timestamp: Date.now(),
          type: "session.failed",
          payload: { error: message },
        });
        return this.refreshSession(session.id) || session;
      }
      return this.refreshSession(session.id) || session;
    }

    const task = this.taskRepo.create({
      title: input.title,
      prompt: effectivePrompt,
      rawPrompt: effectivePrompt,
      userPrompt: userPrompt || effectivePrompt,
      status: "pending",
      workspaceId: environment.config.workspaceId,
      agentConfig: baseAgentConfig,
    });

    const session = this.managedSessionRepo.create({
      id: randomUUID(),
      agentId: agent.id,
      agentVersion: version.version,
      environmentId: environment.id,
      title: input.title,
      status: "pending",
      workspaceId: environment.config.workspaceId,
      backingTaskId: task.id,
      latestSummary: undefined,
    });
    this.managedSessionEventRepo.create({
      sessionId: session.id,
      timestamp: now,
      type: "session.created",
      payload: {
        agentId: agent.id,
        agentVersion: version.version,
        environmentId: environment.id,
        backingTaskId: task.id,
      },
    });
    if (input.initialEvent?.type === "user.message") {
      this.managedSessionEventRepo.create({
        sessionId: session.id,
        timestamp: now,
        type: "user.message",
        payload: { content: input.initialEvent.content },
      });
    }

    await this.agentDaemon.startTask(task);
    return this.refreshSession(session.id) || session;
  }

  listSessions(params?: {
    limit?: number;
    offset?: number;
    workspaceId?: string;
    status?: ManagedSession["status"];
  }): ManagedSession[] {
    return this.managedSessionRepo.list(params).map((session) => {
      if (
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "cancelled"
      ) {
        return session;
      }
      return this.refreshSession(session.id) || session;
    });
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.refreshSession(sessionId);
  }

  listSessionEvents(sessionId: string, limit = 500): ManagedSessionEvent[] {
    const session = this.refreshSession(sessionId);
    if (!session) return [];
    return this.managedSessionEventRepo.listBySessionId(sessionId, limit);
  }

  async cancelSession(sessionId: string): Promise<ManagedSession | undefined> {
    const session = this.managedSessionRepo.findById(sessionId);
    if (!session) return undefined;
    if (session.backingTeamRunId) {
      await this.cancelManagedTeamRun(session.backingTeamRunId);
    }
    if (session.backingTaskId) {
      await this.agentDaemon.cancelTask(session.backingTaskId).catch(() => {});
    }
    this.managedSessionEventRepo.create({
      sessionId,
      timestamp: Date.now(),
      type: "status.changed",
      payload: { status: "cancelled", reason: "user_cancelled" },
    });
    return this.refreshSession(sessionId);
  }

  async resumeSession(sessionId: string): Promise<{ resumed: boolean; session?: ManagedSession }> {
    const session = this.managedSessionRepo.findById(sessionId);
    if (!session?.backingTaskId) return { resumed: false, session };
    if (session.backingTeamRunId) {
      await this.tickManagedTeamRun(session.backingTeamRunId);
      const refreshed = this.refreshSession(sessionId);
      return { resumed: true, session: refreshed };
    }
    const resumed = await this.agentDaemon.resumeTask(session.backingTaskId);
    const refreshed = this.refreshSession(sessionId);
    return { resumed, session: refreshed };
  }

  async sendEvent(
    sessionId: string,
    event:
      | { type: "user.message"; content: ManagedSessionInputContent[] }
      | { type: "input.received"; requestId: string; answers?: InputRequestResponse["answers"]; status?: InputRequestResponse["status"] },
  ): Promise<ManagedSession | undefined> {
    const session = this.managedSessionRepo.findById(sessionId);
    if (!session?.backingTaskId) return undefined;

    if (event.type === "user.message") {
      if (session.backingTeamRunId) {
        throw new Error("user.message is not supported for team-mode managed sessions yet");
      }
      const message = this.materializeContent(event.content);
      this.managedSessionEventRepo.create({
        sessionId,
        timestamp: Date.now(),
        type: "user.message",
        payload: { content: event.content },
      });
      await this.agentDaemon.sendMessage(session.backingTaskId, message);
      return this.refreshSession(sessionId);
    }

    this.managedSessionEventRepo.create({
      sessionId,
      timestamp: Date.now(),
      type: "input.received",
      payload: {
        requestId: event.requestId,
        status: event.status || "submitted",
        answers: event.answers || {},
      },
    });
    await this.agentDaemon.respondToInputRequest({
      requestId: event.requestId,
      status: event.status || "submitted",
      answers: event.answers,
    });
    return this.refreshSession(sessionId);
  }

  bridgeTaskEventNotification(
    taskId: string,
    taskEvent: {
      eventId?: string;
      timestamp?: number;
      type: string;
      payload?: unknown;
      status?: string;
    },
  ): { session?: ManagedSession; appended?: ManagedSessionEvent } {
    const session = this.managedSessionRepo.findByBackingTaskId(taskId);
    if (!session) return {};
    if (taskEvent.eventId && this.managedSessionEventRepo.hasSourceTaskEvent(session.id, taskEvent.eventId)) {
      return { session: this.refreshSession(session.id) || session };
    }
    const appended = this.managedSessionEventRepo.create({
      sessionId: session.id,
      timestamp: taskEvent.timestamp || Date.now(),
      type: this.mapDaemonTaskEvent(taskEvent.type),
      payload: normalizeManagedSessionEventPayload(taskEvent.payload),
      sourceTaskId: taskId,
      sourceTaskEventId: taskEvent.eventId,
    });
    return {
      session: this.refreshSession(session.id) || session,
      appended,
    };
  }

  refreshSession(sessionId: string): ManagedSession | undefined {
    const session = this.managedSessionRepo.findById(sessionId);
    if (!session) return undefined;
    if (session.backingTaskId) {
      this.syncTaskEvents(session);
    }
    let nextSession = this.managedSessionRepo.findById(sessionId) || session;
    if (nextSession.backingTaskId && !nextSession.backingTeamRunId) {
      const run = this.teamRunRepo.findByRootTaskId(nextSession.backingTaskId);
      if (run) {
        nextSession =
          this.managedSessionRepo.update(nextSession.id, { backingTeamRunId: run.id }) || nextSession;
      }
    }

    const task = nextSession.backingTaskId ? this.taskRepo.findById(nextSession.backingTaskId) : undefined;
    const pendingInputs =
      nextSession.backingTaskId ? this.inputRequestRepo.findPendingByTaskId(nextSession.backingTaskId) : [];
    const nextStatus = toManagedSessionStatus(task, pendingInputs.length > 0);
    const latestSummary =
      task?.resultSummary ||
      (nextSession.backingTeamRunId ? this.teamRunRepo.findById(nextSession.backingTeamRunId)?.summary : undefined) ||
      nextSession.latestSummary;
    const completedAt =
      task?.completedAt ||
      (nextSession.backingTeamRunId ? this.teamRunRepo.findById(nextSession.backingTeamRunId)?.completedAt : undefined) ||
      nextSession.completedAt;

    const updates: Partial<ManagedSession> = {};
    if (nextSession.status !== nextStatus) {
      updates.status = nextStatus;
    }
    if (latestSummary && latestSummary !== nextSession.latestSummary) {
      updates.latestSummary = latestSummary;
    }
    if (!nextSession.startedAt && task?.createdAt) {
      updates.startedAt = task.createdAt;
    }
    if (completedAt && completedAt !== nextSession.completedAt) {
      updates.completedAt = completedAt;
    }
    if (Object.keys(updates).length > 0) {
      nextSession = this.managedSessionRepo.update(nextSession.id, updates) || nextSession;
      if (updates.status) {
        this.managedSessionEventRepo.create({
          sessionId: nextSession.id,
          timestamp: Date.now(),
          type:
            updates.status === "completed"
              ? "session.completed"
              : updates.status === "failed"
                ? "session.failed"
                : "status.changed",
          payload: {
            status: updates.status,
            latestSummary: updates.latestSummary || latestSummary,
          },
        });
      }
    }
    return nextSession;
  }

  private syncTaskEvents(session: ManagedSession): void {
    if (!session.backingTaskId) return;
    const events = this.taskEventRepo.findByTaskId(session.backingTaskId);
    for (const event of events) {
      if (this.managedSessionEventRepo.hasSourceTaskEvent(session.id, event.id)) continue;
      this.managedSessionEventRepo.create({
        sessionId: session.id,
        timestamp: event.timestamp,
        type: mapTaskEventType(event),
        payload: normalizeManagedSessionEventPayload(event.payload),
        sourceTaskId: session.backingTaskId,
        sourceTaskEventId: event.id,
      });
    }
  }

  private composeRootPrompt(version: ManagedAgentVersion, userPrompt: string): string {
    const promptParts = [version.systemPrompt.trim()];
    if (userPrompt.trim()) {
      promptParts.push("", "User request:", userPrompt.trim());
    }
    return promptParts.join("\n");
  }

  private materializeContent(content: ManagedSessionInputContent[]): string {
    const lines: string[] = [];
    for (const item of content) {
      if (item.type === "text" && item.text.trim()) {
        lines.push(item.text.trim());
        continue;
      }
      if (item.type === "file") {
        const artifact = this.artifactRepo.findById(item.artifactId);
        lines.push(
          artifact?.path
            ? `[Attached artifact: ${artifact.path}]`
            : `[Attached artifact: ${item.artifactId}]`,
        );
      }
    }
    return lines.join("\n\n").trim();
  }

  private buildAgentConfig(environment: ManagedEnvironment, version: ManagedAgentVersion): AgentConfig {
    const runtimeDefaults = version.runtimeDefaults || {};
    const agentConfig: AgentConfig = {
      ...(version.model?.providerType ? { providerType: version.model.providerType } : {}),
      ...(version.model?.modelKey ? { modelKey: version.model.modelKey } : {}),
      ...(version.model?.llmProfile ? { llmProfile: version.model.llmProfile } : {}),
      ...(runtimeDefaults.autonomousMode !== undefined
        ? { autonomousMode: runtimeDefaults.autonomousMode }
        : {}),
      ...(runtimeDefaults.requireWorktree || environment.config.requireWorktree
        ? { requireWorktree: true }
        : {}),
      ...(runtimeDefaults.allowUserInput !== undefined
        ? { allowUserInput: runtimeDefaults.allowUserInput }
        : {}),
      ...(environment.config.enableShell ? { shellAccess: true } : {}),
      ...(typeof runtimeDefaults.maxTurns === "number" ? { maxTurns: runtimeDefaults.maxTurns } : {}),
      ...(runtimeDefaults.webSearchMode ? { webSearchMode: runtimeDefaults.webSearchMode as Any } : {}),
      ...(runtimeDefaults.toolRestrictions?.length
        ? { toolRestrictions: [...runtimeDefaults.toolRestrictions] }
        : {}),
    };

    const allowedTools = new Set<string>(runtimeDefaults.allowedTools || []);
    const allowedMcpTools = this.resolveAllowedMcpTools(environment);
    for (const tool of allowedMcpTools) allowedTools.add(tool);
    if (allowedTools.size > 0) {
      agentConfig.allowedTools = Array.from(allowedTools);
    }
    if (version.executionMode === "team") {
      const template = version.teamTemplate || {};
      if (template.collaborativeMode) agentConfig.collaborativeMode = true;
      if (template.multiLlmMode) agentConfig.multiLlmMode = true;
    }

    return agentConfig;
  }

  private resolveAllowedMcpTools(environment: ManagedEnvironment): string[] {
    return resolveManagedAllowedMcpTools(environment.config);
  }

  private validateManagedAccountRefs(managedAccountRefs?: string[]): void {
    for (const accountId of managedAccountRefs || []) {
      if (!ManagedAccountManager.getById(accountId)) {
        throw new Error(`Managed account not found: ${accountId}`);
      }
    }
  }

  private async createManagedTeamRun(
    rootTask: Task,
    agent: ManagedAgent,
    version: ManagedAgentVersion,
  ): Promise<{ teamId: string; teamRunId: string }> {
    const activeRoles = this.agentRoleRepo.findAll(false).filter((role) => role.isActive);
    const template = version.teamTemplate || {};
    const leadAgentRoleId =
      (template.leadAgentRoleId && this.agentRoleRepo.findById(template.leadAgentRoleId)?.id) ||
      activeRoles[0]?.id;
    if (!leadAgentRoleId) {
      throw new Error("No active agent role available for managed team session");
    }

    const team = this.teamRepo.create({
      workspaceId: rootTask.workspaceId,
      name: `ManagedAgent-${agent.name}-${Date.now()}`,
      description: `Managed team for agent ${agent.name}`,
      leadAgentRoleId,
      maxParallelAgents: Math.max(1, template.maxParallelAgents || template.memberAgentRoleIds?.length || 1),
      persistent: false,
    });
    for (const [index, roleId] of (template.memberAgentRoleIds || []).entries()) {
      if (!this.agentRoleRepo.findById(roleId)) continue;
      this.teamMemberRepo.add({
        teamId: team.id,
        agentRoleId: roleId,
        memberOrder: (index + 1) * 10,
        isRequired: true,
      });
    }
    const run = this.teamRunRepo.create({
      teamId: team.id,
      rootTaskId: rootTask.id,
      status: "running",
      collaborativeMode: template.collaborativeMode ?? true,
      multiLlmMode: template.multiLlmMode ?? false,
    });

    const memberRoleIds = template.memberAgentRoleIds?.length
      ? template.memberAgentRoleIds
      : [leadAgentRoleId];
    for (const [index, roleId] of memberRoleIds.entries()) {
      if (!this.agentRoleRepo.findById(roleId)) continue;
      this.teamItemRepo.create({
        teamRunId: run.id,
        title: this.agentRoleRepo.findById(roleId)?.displayName || `Agent ${index + 1}`,
        description: rootTask.prompt,
        ownerAgentRoleId: roleId,
        status: "todo",
        sortOrder: (index + 1) * 10,
      });
    }
    return { teamId: team.id, teamRunId: run.id };
  }

  private async tickManagedTeamRun(teamRunId: string): Promise<void> {
    const teamOrchestrator = this.agentDaemon.getTeamOrchestrator();
    if (teamOrchestrator?.tickRun) {
      await teamOrchestrator.tickRun(teamRunId, "managed_session_create");
    }
  }

  private async cancelManagedTeamRun(teamRunId: string): Promise<void> {
    const teamOrchestrator = this.agentDaemon.getTeamOrchestrator();
    if (teamOrchestrator?.cancelRun) {
      await teamOrchestrator.cancelRun(teamRunId);
    }
  }

  private mapDaemonTaskEvent(type: string): ManagedSessionEventType {
    switch (type) {
      case "assistant_message":
        return "assistant.message";
      case "tool_call":
        return "tool.call";
      case "tool_result":
        return "tool.result";
      case "input_request_created":
        return "input.requested";
      case "task_completed":
        return "session.completed";
      case "error":
        return "session.failed";
      case "task_status":
      case "task_paused":
      case "task_resumed":
      case "task_cancelled":
      case "task_interrupted":
        return "status.changed";
      default:
        return "task.event.bridge";
    }
  }
}

import type { TaskEvent, TimelineEventStatus } from "../../../shared/types";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";

export interface ParallelLaneProjection {
  laneKey: string;
  toolUseId?: string;
  toolCallIndex?: number;
  toolName?: string;
  title: string;
  status: TimelineEventStatus;
  startedAt: number;
  finishedAt?: number;
}

export interface ParallelGroupProjection {
  groupId: string;
  label: string;
  status: TimelineEventStatus;
  anchorEventId: string;
  startedAt: number;
  finishedAt?: number;
  lanes: ParallelLaneProjection[];
}

export interface ParallelGroupProjectionResult {
  groupsByAnchorEventId: Map<string, ParallelGroupProjection>;
  suppressedEventIds: Set<string>;
}

interface LaneAccumulator {
  laneKey: string;
  toolUseId?: string;
  toolCallIndex?: number;
  toolName?: string;
  title?: string;
  status: TimelineEventStatus;
  startedAt: number;
  finishedAt?: number;
  firstOrder: number;
}

interface GroupAccumulator {
  groupId: string;
  label?: string;
  firstEventId: string;
  firstTimestamp: number;
  firstOrder: number;
  startedEvent?: TaskEvent;
  finishedEvent?: TaskEvent;
  lanesByKey: Map<string, LaneAccumulator>;
  stepToLaneKey: Map<string, string>;
  eventIds: Set<string>;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toTimelineStatus(value: unknown, fallback: TimelineEventStatus): TimelineEventStatus {
  if (typeof value !== "string") return fallback;
  switch (value) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
    case "blocked":
    case "skipped":
    case "cancelled":
      return value;
    default:
      return fallback;
  }
}

export function getEventGroupId(event: TaskEvent): string | null {
  if (typeof event.groupId === "string" && event.groupId.trim().length > 0) {
    return event.groupId.trim();
  }
  const payload = asObject(event.payload);
  if (typeof payload.groupId === "string" && payload.groupId.trim().length > 0) {
    return payload.groupId.trim();
  }
  return null;
}

export function isToolsParallelGroupId(groupId: string | null | undefined): boolean {
  if (!groupId) return false;
  return groupId.trim().toLowerCase().startsWith("tools:");
}

function extractStepId(event: TaskEvent): string | undefined {
  if (typeof event.stepId === "string" && event.stepId.trim().length > 0) {
    return event.stepId.trim();
  }
  const payload = asObject(event.payload);
  if (typeof payload.stepId === "string" && payload.stepId.trim().length > 0) {
    return payload.stepId.trim();
  }
  const step = asObject(payload.step);
  if (typeof step.id === "string" && step.id.trim().length > 0) {
    return step.id.trim();
  }
  return undefined;
}

function extractToolUseIdFromStepId(stepId: string | undefined): string | undefined {
  if (!stepId) return undefined;
  const match = /^tool_lane:(?:step|follow_up):(.+)$/i.exec(stepId.trim());
  if (!match || typeof match[1] !== "string") return undefined;
  const toolUseId = match[1].trim();
  return toolUseId.length > 0 ? toolUseId : undefined;
}

function getToolCallIndex(payload: Record<string, unknown>): number | undefined {
  const raw = payload.toolCallIndex;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const value = Math.floor(raw);
  return value > 0 ? value : undefined;
}

function ensureLane(
  group: GroupAccumulator,
  laneKey: string,
  firstOrder: number,
  timestamp: number,
): LaneAccumulator {
  const existing = group.lanesByKey.get(laneKey);
  if (existing) return existing;
  const lane: LaneAccumulator = {
    laneKey,
    status: "in_progress",
    startedAt: timestamp,
    firstOrder,
  };
  group.lanesByKey.set(laneKey, lane);
  return lane;
}

function laneTitleForToolName(toolName: string | undefined): string {
  if (!toolName || toolName.trim().length === 0) return "Running tool";
  return `Running ${toolName.trim()}`;
}

function inferGroupStatus(group: GroupAccumulator): TimelineEventStatus {
  if (group.finishedEvent) {
    return toTimelineStatus(group.finishedEvent.status, "completed");
  }
  let hasInProgress = false;
  let hasFailure = false;
  for (const lane of group.lanesByKey.values()) {
    if (lane.status === "in_progress" || lane.status === "pending") hasInProgress = true;
    if (lane.status === "failed" || lane.status === "blocked" || lane.status === "cancelled") {
      hasFailure = true;
    }
  }
  if (hasInProgress) return "in_progress";
  if (hasFailure) return "failed";
  return "completed";
}

export function buildParallelGroupProjection(events: TaskEvent[]): ParallelGroupProjectionResult {
  const groupsById = new Map<string, GroupAccumulator>();

  events.forEach((event, index) => {
    const groupId = getEventGroupId(event);
    if (!isToolsParallelGroupId(groupId)) return;
    if (!groupId) return;

    let group = groupsById.get(groupId);
    if (!group) {
      group = {
        groupId,
        firstEventId: event.id,
        firstTimestamp: event.timestamp,
        firstOrder: index,
        lanesByKey: new Map<string, LaneAccumulator>(),
        stepToLaneKey: new Map<string, string>(),
        eventIds: new Set<string>(),
      };
      groupsById.set(groupId, group);
    }

    group.eventIds.add(event.id);
    const payload = asObject(event.payload);
    const effectiveType = getEffectiveTaskEventType(event);

    if (event.type === "timeline_group_started") {
      group.startedEvent = event;
      const groupLabel =
        typeof payload.groupLabel === "string" && payload.groupLabel.trim().length > 0
          ? payload.groupLabel.trim()
          : undefined;
      if (groupLabel) group.label = groupLabel;
    } else if (event.type === "timeline_group_finished") {
      group.finishedEvent = event;
      const groupLabel =
        typeof payload.groupLabel === "string" && payload.groupLabel.trim().length > 0
          ? payload.groupLabel.trim()
          : undefined;
      if (groupLabel) group.label = groupLabel;
    }

    const isLaneEvent =
      event.type === "timeline_step_started" ||
      event.type === "timeline_step_updated" ||
      event.type === "timeline_step_finished" ||
      effectiveType === "tool_call" ||
      effectiveType === "tool_result" ||
      effectiveType === "tool_error";
    if (!isLaneEvent) return;

    const stepId = extractStepId(event);
    const toolUseIdFromStep = extractToolUseIdFromStepId(stepId);
    const toolUseIdFromPayload =
      typeof payload.toolUseId === "string" && payload.toolUseId.trim().length > 0
        ? payload.toolUseId.trim()
        : undefined;
    const toolUseId = toolUseIdFromPayload ?? toolUseIdFromStep;
    const laneKey =
      toolUseId ??
      (stepId && stepId.length > 0 ? stepId : `group:${groupId}:event:${group.eventIds.size}`);

    const lane = ensureLane(group, laneKey, index, event.timestamp);
    if (toolUseId) lane.toolUseId = toolUseId;
    if (stepId) group.stepToLaneKey.set(stepId, laneKey);

    if (event.type === "timeline_step_started" || event.type === "timeline_step_updated") {
      lane.startedAt = Math.min(lane.startedAt, event.timestamp);
      const message =
        typeof payload.message === "string" && payload.message.trim().length > 0
          ? payload.message.trim()
          : (() => {
              const step = asObject(payload.step);
              return typeof step.description === "string" ? step.description.trim() : "";
            })();
      if (message) lane.title = message;
      lane.status = toTimelineStatus(event.status, lane.status || "in_progress");
      return;
    }

    if (event.type === "timeline_step_finished") {
      lane.finishedAt = event.timestamp;
      lane.status = toTimelineStatus(event.status, "completed");
      const message =
        typeof payload.message === "string" && payload.message.trim().length > 0
          ? payload.message.trim()
          : "";
      if (message) {
        lane.title = message;
      } else {
        const finalName = lane.toolName || "";
        if (finalName) {
          lane.title = `${finalName} ${lane.status === "failed" ? "failed" : "done"}`;
        }
      }
      return;
    }

    if (effectiveType === "tool_call") {
      lane.startedAt = Math.min(lane.startedAt, event.timestamp);
      const toolName = typeof payload.tool === "string" ? payload.tool.trim() : "";
      if (toolName) {
        lane.toolName = toolName;
        lane.title = lane.title || laneTitleForToolName(toolName);
      }
      const callIndex = getToolCallIndex(payload);
      if (callIndex) lane.toolCallIndex = callIndex;
      lane.status = "in_progress";
      return;
    }

    if (effectiveType === "tool_error") {
      const toolName = typeof payload.tool === "string" ? payload.tool.trim() : "";
      if (toolName) {
        lane.toolName = toolName;
        if (!lane.title) lane.title = laneTitleForToolName(toolName);
      }
      const callIndex = getToolCallIndex(payload);
      if (callIndex) lane.toolCallIndex = callIndex;
      lane.finishedAt = event.timestamp;
      lane.status = "failed";
      const finalName = toolName || lane.toolName || "";
      if (finalName) {
        // Only overwrite with the "failed" suffix if the lane has no descriptive
        // title yet (or still holds the generic tool-name placeholder). A title
        // set by a progress/step event is more informative and should be kept.
        const isGenericOrEmpty = !lane.title || lane.title === laneTitleForToolName(finalName);
        if (isGenericOrEmpty) lane.title = `${finalName} failed`;
      }
      return;
    }

    if (effectiveType === "tool_result") {
      const toolName = typeof payload.tool === "string" ? payload.tool.trim() : "";
      if (toolName) {
        lane.toolName = toolName;
        if (!lane.title) lane.title = laneTitleForToolName(toolName);
      }
      const callIndex = getToolCallIndex(payload);
      if (callIndex) lane.toolCallIndex = callIndex;
      lane.finishedAt = event.timestamp;
      if (lane.status !== "failed") {
        lane.status = "completed";
      }
      const finalName = toolName || lane.toolName || "";
      if (finalName) {
        // Only overwrite with "done/failed" if the lane has no descriptive title
        // yet. A title set by a progress/step event is more informative.
        const suffix = lane.status === "failed" ? "failed" : "done";
        const isGenericOrEmpty = !lane.title || lane.title === laneTitleForToolName(finalName);
        if (isGenericOrEmpty) lane.title = `${finalName} ${suffix}`;
      }
    }
  });

  // Second pass: collect all lane toolUseIds so we can suppress orphaned
  // tool_result / tool_error events that were emitted without a "tools:" groupId
  // but whose callId matches a lane already captured inside a group.
  const allLaneToolUseIds = new Set<string>();
  for (const group of groupsById.values()) {
    for (const lane of group.lanesByKey.values()) {
      if (lane.toolUseId) allLaneToolUseIds.add(lane.toolUseId);
    }
  }

  const orphanSuppressedIds = new Set<string>();
  if (allLaneToolUseIds.size > 0) {
    events.forEach((event) => {
      const groupId = getEventGroupId(event);
      if (isToolsParallelGroupId(groupId)) return; // already handled in first pass

      const effectiveType = getEffectiveTaskEventType(event);
      if (effectiveType !== "tool_result" && effectiveType !== "tool_error") return;

      const payload = asObject(event.payload);
      const callId = typeof payload.callId === "string" ? payload.callId.trim() : "";
      if (!callId || !allLaneToolUseIds.has(callId)) return;

      orphanSuppressedIds.add(event.id);

      // Also update the matching lane with completion info
      for (const group of groupsById.values()) {
        for (const lane of group.lanesByKey.values()) {
          if (lane.toolUseId !== callId) continue;
          const toolName = typeof payload.tool === "string" ? payload.tool.trim() : "";
          const finalName = toolName || lane.toolName || "";
          if (effectiveType === "tool_result") {
            lane.finishedAt = event.timestamp;
            if (lane.status !== "failed") {
              lane.status = "completed";
              if (finalName) {
                const isGenericOrEmpty = !lane.title || lane.title === laneTitleForToolName(finalName);
                if (isGenericOrEmpty) lane.title = `${finalName} done`;
              }
            }
          } else {
            lane.finishedAt = event.timestamp;
            lane.status = "failed";
            if (finalName) {
              const isGenericOrEmpty = !lane.title || lane.title === laneTitleForToolName(finalName);
              if (isGenericOrEmpty) lane.title = `${finalName} failed`;
            }
          }
          break;
        }
      }
    });
  }

  const groupsByAnchorEventId = new Map<string, ParallelGroupProjection>();
  const suppressedEventIds = new Set<string>();

  for (const group of groupsById.values()) {
    const anchorEventId = group.startedEvent?.id || group.firstEventId;
    for (const eventId of group.eventIds.values()) {
      if (eventId !== anchorEventId) suppressedEventIds.add(eventId);
    }

    const startedAt = group.startedEvent?.timestamp ?? group.firstTimestamp;
    const finishedAt = group.finishedEvent?.timestamp;
    const status = inferGroupStatus(group);
    const lanes = Array.from(group.lanesByKey.values())
      .sort((a, b) => {
        const aIndex = typeof a.toolCallIndex === "number" ? a.toolCallIndex : Number.POSITIVE_INFINITY;
        const bIndex = typeof b.toolCallIndex === "number" ? b.toolCallIndex : Number.POSITIVE_INFINITY;
        if (aIndex !== bIndex) return aIndex - bIndex;
        if (a.firstOrder !== b.firstOrder) return a.firstOrder - b.firstOrder;
        return a.laneKey.localeCompare(b.laneKey);
      })
      .map((lane) => ({
        laneKey: lane.laneKey,
        toolUseId: lane.toolUseId,
        toolCallIndex: lane.toolCallIndex,
        toolName: lane.toolName,
        title:
          lane.title ||
          laneTitleForToolName(lane.toolName) ||
          "Running tool",
        status: lane.status,
        startedAt: lane.startedAt,
        ...(typeof lane.finishedAt === "number" ? { finishedAt: lane.finishedAt } : {}),
      }));

    groupsByAnchorEventId.set(anchorEventId, {
      groupId: group.groupId,
      label: group.label || "Running tasks in parallel",
      status,
      anchorEventId,
      startedAt,
      ...(typeof finishedAt === "number" ? { finishedAt } : {}),
      lanes,
    });
  }

  for (const id of orphanSuppressedIds) {
    suppressedEventIds.add(id);
  }

  return {
    groupsByAnchorEventId,
    suppressedEventIds,
  };
}

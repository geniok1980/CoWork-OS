import { describe, expect, it } from "vitest";

import type { Task, TaskEvent } from "../../../shared/types";
import { isTaskActivelyWorking } from "../MainContent";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Test task",
    prompt: "Test prompt",
    status: "executing",
    createdAt: 0,
    updatedAt: 0,
    executionMode: "execute",
    ...overrides,
  } as Task;
}

function makeEvent(
  id: string,
  timestamp: number,
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type,
    payload,
  } as TaskEvent;
}

describe("isTaskActivelyWorking", () => {
  it("keeps executing tasks active when newer progress follows an older completed follow-up", () => {
    const task = makeTask();
    const events = [
      makeEvent("follow-up-done", 1_000, "follow_up_completed"),
      makeEvent("step-progress", 2_000, "timeline_step_updated", {
        legacyType: "progress_update",
        message: "Working on your request",
      }),
    ];

    expect(isTaskActivelyWorking(task, events, false, 2_500)).toBe(true);
  });

  it("marks executing tasks idle when the latest relevant event is a completed follow-up", () => {
    const task = makeTask();
    const events = [makeEvent("follow-up-done", 2_000, "follow_up_completed")];

    expect(isTaskActivelyWorking(task, events, false, 2_500)).toBe(false);
  });

  it("does not treat generic error events as terminal while the task is still executing", () => {
    const task = makeTask();
    const events = [makeEvent("tool-side-error", 2_000, "error", { error: "Image generation failed" })];

    expect(isTaskActivelyWorking(task, events, false, 2_500)).toBe(true);
  });
});

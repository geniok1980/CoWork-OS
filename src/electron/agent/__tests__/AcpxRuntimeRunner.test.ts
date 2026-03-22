import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  AcpxRuntimeRunner,
  AcpxRuntimeUnavailableError,
  buildAcpxBaseArgs,
  buildAcpxCommandArgs,
  getAcpxPermissionArgs,
  getAcpxSessionName,
  mapAcpxSessionUpdate,
} from "../AcpxRuntimeRunner";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcessMocks.spawn,
}));

function createFakeProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners = new Map<string, Array<(...args: Any[]) => void>>();
  const proc: Any = {
    stdout,
    stderr,
    stdin: new PassThrough(),
    killed: false,
    kill: vi.fn().mockImplementation(() => {
      proc.killed = true;
      return true;
    }),
    once: vi.fn((event: string, cb: (...args: Any[]) => void) => {
      const existing = listeners.get(event) || [];
      existing.push(cb);
      listeners.set(event, existing);
      return proc;
    }),
    emit(event: string, ...args: Any[]) {
      for (const cb of listeners.get(event) || []) {
        cb(...args);
      }
    },
  };
  return proc;
}

describe("AcpxRuntimeRunner helpers", () => {
  beforeEach(() => {
    childProcessMocks.spawn.mockReset();
  });

  it("builds deterministic session names", () => {
    expect(getAcpxSessionName("task-123")).toBe("cowork-task-123");
  });

  it("maps permission modes to acpx flags", () => {
    expect(getAcpxPermissionArgs("approve-reads")).toEqual(["--approve-reads"]);
    expect(getAcpxPermissionArgs("approve-all")).toEqual(["--approve-all"]);
    expect(getAcpxPermissionArgs("deny-all")).toEqual(["--deny-all"]);
  });

  it("builds acpx base args with ttl and non-interactive policy", () => {
    expect(
      buildAcpxBaseArgs({
        cwd: "/repo",
        runtimeConfig: {
          kind: "acpx",
          agent: "codex",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "approve-reads",
          ttlSeconds: 60,
        },
      }),
    ).toEqual([
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      "/repo",
      "--approve-reads",
      "--non-interactive-permissions",
      "fail",
      "--ttl",
      "60",
    ]);
  });

  it("builds full acpx command args for prompt execution", () => {
    expect(
      buildAcpxCommandArgs({
        cwd: "/repo",
        runtimeConfig: {
          kind: "acpx",
          agent: "codex",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "deny-all",
        },
        commandArgs: ["prompt", "--session", "cowork-task-1", "--file", "-"],
      }),
    ).toEqual([
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      "/repo",
      "--deny-all",
      "--non-interactive-permissions",
      "fail",
      "codex",
      "prompt",
      "--session",
      "cowork-task-1",
      "--file",
      "-",
    ]);
  });

  it("maps tool call updates into command and tool events", () => {
    expect(
      mapAcpxSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "List files",
        kind: "search",
        status: "in_progress",
        rawInput: {
          command: ["/bin/zsh", "-lc", "ls -1A"],
          cwd: "/repo",
          parsed_cmd: [{ type: "list_files" }],
        },
      }),
    ).toEqual([
      {
        type: "command_output",
        payload: {
          command: "/bin/zsh -lc \"ls -1A\"",
          cwd: "/repo",
          type: "start",
          output: "$ /bin/zsh -lc \"ls -1A\"\n",
        },
      },
      {
        type: "tool_call",
        payload: {
          tool: "list_files",
          kind: "search",
          title: "List files",
          toolCallId: "call_1",
          status: "in_progress",
          input: {
            command: ["/bin/zsh", "-lc", "ls -1A"],
            cwd: "/repo",
            parsed_cmd: [{ type: "list_files" }],
          },
          command: "/bin/zsh -lc \"ls -1A\"",
          cwd: "/repo",
        },
      },
    ]);
  });

  it("maps tool completion updates into stdout and tool results", () => {
    expect(
      mapAcpxSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawOutput: {
          command: ["/bin/zsh", "-lc", "ls -1A"],
          cwd: "/repo",
          formatted_output: "src\npackage.json\n",
          stderr: "",
          exit_code: 0,
        },
      }),
    ).toEqual([
      {
        type: "command_output",
        payload: {
          command: "/bin/zsh -lc \"ls -1A\"",
          cwd: "/repo",
          type: "stdout",
          output: "src\npackage.json\n",
        },
      },
      {
        type: "tool_result",
        payload: {
          tool: "tool",
          toolCallId: "call_1",
          status: "completed",
          success: true,
          error: undefined,
          result: {
            command: ["/bin/zsh", "-lc", "ls -1A"],
            cwd: "/repo",
            formatted_output: "src\npackage.json\n",
            stderr: "",
            exit_code: 0,
          },
          exitCode: 0,
        },
      },
    ]);
  });
});

describe("AcpxRuntimeRunner", () => {
  beforeEach(() => {
    childProcessMocks.spawn.mockReset();
  });

  it("parses NDJSON prompt output into CoWork events and final assistant text", async () => {
    const proc = createFakeProcess();
    childProcessMocks.spawn.mockReturnValue(proc);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new AcpxRuntimeRunner({
      taskId: "task-1",
      cwd: "/repo",
      runtimeConfig: {
        kind: "acpx",
        agent: "codex",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
      emitEvent: (type, payload) => {
        events.push({ type, payload });
      },
    });

    const promptPromise = runner.prompt("Review the patch");
    proc.stdout.write(
      [
        JSON.stringify({
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call_1",
              title: "List files",
              kind: "search",
              status: "in_progress",
              rawInput: {
                command: ["/bin/zsh", "-lc", "ls -1A"],
                cwd: "/repo",
                parsed_cmd: [{ type: "list_files" }],
              },
            },
          },
        }),
        JSON.stringify({
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call_1",
              status: "completed",
              rawOutput: {
                command: ["/bin/zsh", "-lc", "ls -1A"],
                cwd: "/repo",
                formatted_output: "src\n",
                stderr: "",
                exit_code: 0,
              },
            },
          },
        }),
        JSON.stringify({
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Done." },
            },
          },
        }),
        JSON.stringify({
          result: {
            stopReason: "end_turn",
            sessionId: "session-1",
          },
        }),
      ].join("\n") + "\n",
    );
    proc.emit("close", 0);

    await expect(promptPromise).resolves.toEqual({
      assistantText: "Done.",
      stopReason: "end_turn",
      sessionId: "session-1",
    });
    expect(events.map((event) => event.type)).toEqual([
      "progress_update",
      "command_output",
      "tool_call",
      "command_output",
      "tool_result",
      "assistant_message",
    ]);
  });

  it("logs malformed JSON lines and continues", async () => {
    const proc = createFakeProcess();
    childProcessMocks.spawn.mockReturnValue(proc);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new AcpxRuntimeRunner({
      taskId: "task-1",
      cwd: "/repo",
      runtimeConfig: {
        kind: "acpx",
        agent: "codex",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
      emitEvent: (type, payload) => {
        events.push({ type, payload });
      },
    });

    const promptPromise = runner.prompt("Review the patch");
    proc.stdout.write("not-json\n");
    proc.stdout.write(
      JSON.stringify({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Okay" },
          },
        },
      }) + "\n",
    );
    proc.emit("close", 0);

    await expect(promptPromise).resolves.toEqual({
      assistantText: "Okay",
      stopReason: undefined,
      sessionId: undefined,
    });
    expect(events.some((event) => event.type === "log")).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "assistant_message",
      payload: { message: "Okay" },
    });
  });

  it("surfaces missing acpx as a runtime-unavailable error", async () => {
    childProcessMocks.spawn.mockImplementation(() => {
      const proc = createFakeProcess();
      queueMicrotask(() => {
        proc.emit("error", Object.assign(new Error("spawn acpx ENOENT"), { code: "ENOENT" }));
      });
      return proc;
    });
    const runner = new AcpxRuntimeRunner({
      taskId: "task-1",
      cwd: "/repo",
      runtimeConfig: {
        kind: "acpx",
        agent: "codex",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
      emitEvent: () => undefined,
    });

    await expect(runner.createSession()).rejects.toBeInstanceOf(AcpxRuntimeUnavailableError);
  });

  it("rejects when acpx exits non-zero", async () => {
    const proc = createFakeProcess();
    childProcessMocks.spawn.mockReturnValue(proc);
    const runner = new AcpxRuntimeRunner({
      taskId: "task-1",
      cwd: "/repo",
      runtimeConfig: {
        kind: "acpx",
        agent: "codex",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
      emitEvent: () => undefined,
    });

    const promptPromise = runner.prompt("Review the patch");
    proc.stderr.write("adapter crashed");
    proc.emit("close", 1);

    await expect(promptPromise).rejects.toThrow("adapter crashed");
  });
});

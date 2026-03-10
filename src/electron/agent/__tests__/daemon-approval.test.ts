import { describe, expect, it, vi, afterEach } from "vitest";
import { AgentDaemon } from "../daemon";

describe("AgentDaemon.requestApproval auto-approve controls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps auto-approve behavior by default", async () => {
    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-1" }),
      update: vi.fn(),
    };

    const daemonLike = {
      sessionAutoApproveAll: true,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { autonomousMode: true } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approved = await AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-1",
      "external_service",
      "Approve action",
      { tool: "x402_fetch" },
    );

    expect(approved).toBe(true);
    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "approved",
      }),
    );
  });

  it("disables auto-approve when allowAutoApprove=false is passed", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-2" }),
      update: vi.fn(),
    };

    const daemonLike = {
      sessionAutoApproveAll: true,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { autonomousMode: true } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approvalPromise = AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-2",
      "external_service",
      "Approve payment",
      { tool: "x402_fetch" },
      { allowAutoApprove: false },
    );

    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(1);

    const pending = daemonLike.pendingApprovals.get("approval-2");
    clearTimeout(pending.timeoutHandle);
    pending.resolve(true);

    await expect(approvalPromise).resolves.toBe(true);
  });

  it("scopes task auto-approve to explicitly allowed approval types", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-3" }),
      update: vi.fn(),
    };

    const daemonLike = {
      sessionAutoApproveAll: false,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          agentConfig: {
            autonomousMode: true,
            autoApproveTypes: ["run_command"],
          },
        }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approvalPromise = AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-3",
      "external_service",
      "Approve external side effect",
      { tool: "x402_fetch" },
    );

    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        type: "external_service",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(1);

    const pending = daemonLike.pendingApprovals.get("approval-3");
    clearTimeout(pending.timeoutHandle);
    pending.resolve(false);

    await expect(approvalPromise).resolves.toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  buildWorkerRolePrompt,
  getWorkerRoleSpec,
  parseVerificationVerdict,
  resolveDefaultWorkerRoleKind,
  resolveWorkerRoleAgentConfig,
} from "../worker-role-registry";

describe("worker-role-registry", () => {
  it("keeps implementer as the default and verifier read-only", () => {
    expect(resolveDefaultWorkerRoleKind()).toBe("implementer");

    const verifier = resolveWorkerRoleAgentConfig("verifier", {});
    expect(verifier.executionMode).toBe("verified");
    expect(verifier.allowUserInput).toBe(false);
    expect(verifier.toolRestrictions).toEqual(expect.arrayContaining(["group:write", "spawn_agent"]));
  });

  it("builds a worker prompt with the role contract", () => {
    const prompt = buildWorkerRolePrompt("researcher", {
      taskTitle: "Review release notes",
      taskPrompt: "Summarize useful changes",
      workspacePath: "/tmp/workspace",
      parentSummary: "Previous step found 3 relevant items",
      outputSummary: "Read docs and compared release notes",
    });

    expect(prompt).toContain("WORKER ROLE: Researcher");
    expect(prompt).toContain("Completion contract:");
    expect(prompt).toContain("Summarize useful changes");
  });

  it("parses verification verdict markers", () => {
    expect(parseVerificationVerdict("VERDICT: PASS")).toBe("PASS");
    expect(parseVerificationVerdict("VERDICT: PARTIAL")).toBe("PARTIAL");
    expect(parseVerificationVerdict("no verdict marker")).toBe("FAIL");
  });

  it("exposes the built-in worker role specs", () => {
    expect(getWorkerRoleSpec("synthesizer").mutationAllowed).toBe(true);
    expect(getWorkerRoleSpec("researcher").mutationAllowed).toBe(false);
  });
});

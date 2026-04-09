import { afterEach, describe, expect, it, vi } from "vitest";

import { MCPSettingsManager } from "../../mcp/settings";
import {
  resolveManagedAllowedMcpTools,
  sanitizeManagedEventPayload,
} from "../ManagedSessionService";

describe("sanitizeManagedEventPayload", () => {
  it("redacts sensitive keys and truncates oversized message bodies", () => {
    const sanitized = sanitizeManagedEventPayload({
      prompt: "hidden",
      apiKey: "secret",
      nested: {
        authorization: "Bearer abc",
      },
      message: "x".repeat(13_000),
    }) as Record<string, unknown>;

    expect(sanitized.prompt).toBe("[REDACTED]");
    expect(sanitized.apiKey).toBe("[REDACTED]");
    expect((sanitized.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect(String(sanitized.message)).toContain("[... truncated");
  });
});

describe("resolveManagedAllowedMcpTools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed when a referenced MCP server is missing", () => {
    vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({ toolNamePrefix: "mcp_" } as Any);
    vi.spyOn(MCPSettingsManager, "getServer").mockReturnValue(undefined);

    expect(() =>
      resolveManagedAllowedMcpTools({
        allowedMcpServerIds: ["missing-server"],
      }),
    ).toThrow(/unknown MCP server/i);
  });

  it("returns a prefixed allowlist when cached tool metadata is available", () => {
    vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({ toolNamePrefix: "mcp_" } as Any);
    vi.spyOn(MCPSettingsManager, "getServer").mockReturnValue({
      id: "server-1",
      tools: [{ name: "search" }, { name: "fetch" }],
    } as Any);

    expect(
      resolveManagedAllowedMcpTools({
        allowedMcpServerIds: ["server-1"],
      }),
    ).toEqual(["mcp_search", "mcp_fetch"]);
  });
});

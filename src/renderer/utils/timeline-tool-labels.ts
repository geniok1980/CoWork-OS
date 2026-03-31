/**
 * User-facing labels for agent tool calls (timeline / step feed).
 * Prefer plain language over raw tool ids (snake_case).
 */

const TRUNC = 72;

export function truncateLabel(s: string, max = TRUNC): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Short label for parallel lane "running" state */
export function friendlyToolRunningLabel(toolName: string | undefined): string {
  const t = (toolName || "").trim();
  if (!t) return "Running tool";
  switch (t) {
    case "web_fetch":
    case "http_request":
      return "Fetching a web page";
    case "web_search":
      return "Searching the web";
    case "read_file":
    case "read_files":
      return "Reading a file";
    case "list_directory":
      return "Listing a folder";
    case "glob":
      return "Finding files";
    case "grep":
      return "Searching in files";
    case "search_files":
      return "Searching the codebase";
    case "write_file":
      return "Writing a file";
    case "edit_file":
      return "Editing a file";
    case "run_command":
      return "Running a command";
    case "task_history":
      return "Checking task history";
    default:
      return `Using ${t.replace(/_/g, " ")}`;
  }
}

function hostOrPathFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const suffix = `${u.pathname || ""}${u.search || ""}`;
    const normalizedSuffix = suffix && suffix !== "/" ? suffix : "";
    return `${u.hostname || ""}${normalizedSuffix}` || url;
  } catch {
    return url;
  }
}

type ToolInput = Record<string, unknown> | null | undefined;
type ToolResult = Record<string, unknown> | null | undefined;

/** Title for a tool_call row (present tense / intent). */
export function friendlyToolCallTitle(tool: string | undefined, input: ToolInput): string {
  const tc = (tool || "").trim();
  if (!tc) return "Tool call";

  const ins = input && typeof input === "object" ? input : {};

  if (tc === "web_fetch" || tc === "http_request") {
    const url = typeof ins.url === "string" ? ins.url.trim() : "";
    return url ? `Fetching ${truncateLabel(hostOrPathFromUrl(url), 60)}` : "Fetching a web page";
  }
  if (tc === "web_search") {
    const q = typeof ins.query === "string" ? ins.query.trim() : "";
    const provider = typeof ins.provider === "string" ? ins.provider.trim() : "";
    const via = provider ? ` via ${provider.charAt(0).toUpperCase() + provider.slice(1)}` : "";
    return q ? `Web search${via}: ${truncateLabel(q, 52)}` : `Web search${via}`;
  }
  if (tc === "read_file") {
    const path = typeof ins.path === "string" ? ins.path.trim() : "";
    const base = path ? path.split("/").pop() || path : "";
    return base ? `Read ${base}` : "Read file";
  }
  if (tc === "grep" || tc === "search_files") {
    const pattern = typeof ins.pattern === "string" ? ins.pattern.trim() : "";
    return pattern ? `Search in files: ${truncateLabel(pattern, 48)}` : "Search in files";
  }
  if (tc === "run_command") {
    const cmd = typeof ins.command === "string" ? ins.command.trim() : "";
    return cmd ? `Run: ${truncateLabel(cmd, 56)}` : "Run command";
  }
  if (tc === "write_file") {
    const path = typeof ins.path === "string" ? ins.path.trim() : "";
    const base = path ? path.split("/").pop() || path : "";
    return base ? `Write ${base}` : "Write file";
  }
  if (tc === "edit_file") {
    const path = typeof ins.file_path === "string" ? ins.file_path.trim() : "";
    const base = path ? path.split("/").pop() || path : "";
    return base ? `Edit ${base}` : "Edit file";
  }
  if (tc === "glob") {
    const pattern = typeof ins.pattern === "string" ? ins.pattern.trim() : "";
    return pattern ? `Find files: ${truncateLabel(pattern, 52)}` : "Find files";
  }

  return friendlyToolRunningLabel(tc);
}

/** Title for a tool_result row when shown alone (past tense / outcome). */
export function friendlyToolResultTitle(
  tool: string | undefined,
  result: ToolResult,
  success: boolean,
): string {
  const tc = (tool || "").trim();
  const res = result && typeof result === "object" ? result : {};
  const err = typeof res.error === "string" ? res.error : "";

  if (!success && err) {
    const clipped = truncateLabel(err, 64);
    return tc ? `${friendlyPastVerb(tc)} — ${clipped}` : clipped;
  }

  if (tc === "web_fetch" || tc === "http_request") {
    const url = typeof res.url === "string" ? res.url.trim() : "";
    const title = typeof res.title === "string" ? res.title.trim() : "";
    const bit = title || (url ? hostOrPathFromUrl(url) : "");
    return bit ? `Fetched ${truncateLabel(bit, 64)}` : "Fetched page";
  }
  if (tc === "web_search") {
    const q = typeof res.query === "string" ? res.query.trim() : "";
    const provider = typeof res.provider === "string" ? res.provider.trim() : "";
    const via = provider ? ` via ${provider.charAt(0).toUpperCase() + provider.slice(1)}` : "";
    return q ? `Searched${via}: ${truncateLabel(q, 52)}` : `Search complete${via}`;
  }
  if (tc === "read_file") {
    const path = typeof res.path === "string" ? res.path.trim() : "";
    const base = path ? path.split("/").pop() || path : "";
    return base ? `Read ${base}` : "Read file";
  }

  return `${friendlyPastVerb(tc)}${detailSuffix(res, tc)}`;
}

/** Lane row when a parallel tool lane finishes */
export function friendlyToolLaneCompletedLabel(toolName: string | undefined, failed: boolean): string {
  const t = (toolName || "").trim();
  if (!t) return failed ? "Step failed" : "Done";
  if (failed) {
    switch (t) {
      case "web_fetch":
      case "http_request":
        return "Fetch failed";
      case "web_search":
        return "Search failed";
      default:
        return `${friendlyToolRunningLabel(t)} failed`;
    }
  }
  switch (t) {
    case "web_fetch":
    case "http_request":
      return "Fetched page";
    case "web_search":
      return "Searched web";
    case "grep":
    case "search_files":
      return "Search complete";
    default:
      return `${friendlyPastVerb(t)}`;
  }
}

function friendlyPastVerb(tool: string): string {
  switch (tool) {
    case "web_fetch":
    case "http_request":
      return "Fetched page";
    case "web_search":
      return "Searched web";
    case "grep":
      return "Searched in files";
    case "search_files":
      return "Searched files";
    case "read_file":
      return "Read file";
    case "run_command":
      return "Ran command";
    case "write_file":
      return "Wrote file";
    case "edit_file":
      return "Edited file";
    case "glob":
      return "Matched files";
    case "task_history":
      return "Loaded task history";
    default:
      return `${tool.replace(/_/g, " ")} done`;
  }
}

function detailSuffix(res: Record<string, unknown>, tool: string): string {
  if (typeof res.path === "string" && res.path.trim()) {
    const base = res.path.split("/").pop() || res.path;
    return ` — ${truncateLabel(base, 48)}`;
  }
  if (Array.isArray(res.matches) && res.matches.length > 0) {
    return ` — ${res.matches.length} match${res.matches.length === 1 ? "" : "es"}`;
  }
  if (Array.isArray(res.files) && res.files.length > 0) {
    return ` — ${res.files.length} file${res.files.length === 1 ? "" : "s"}`;
  }
  if (res.content && typeof res.content === "string") {
    const lines = res.content.split("\n").length;
    return ` — ${lines} lines`;
  }
  if (tool === "run_command" && typeof res.exitCode === "number") {
    return res.exitCode === 0 ? "" : ` (exit ${res.exitCode})`;
  }
  return "";
}

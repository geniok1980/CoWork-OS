import type { ImprovementCandidate } from "../../shared/types";

export function buildImprovementExperimentPrompt(candidate: ImprovementCandidate): string {
  const lines: string[] = [
    "You are running a self-improvement experiment for Cowork OS.",
    "Your goal is to fix a concrete recurring issue in a safe, branch-isolated way.",
    "",
    "Success contract:",
    "1. Reproduce or tightly validate the issue from the evidence below.",
    "2. Implement the smallest fix that resolves the issue.",
    "3. Run targeted verification or tests when possible.",
    "4. Summarize exactly what changed, how you verified it, and any remaining risk.",
    "5. If you cannot confidently improve the issue, say so clearly instead of making speculative changes.",
    "",
    "Safety constraints:",
    "- You are in an autonomous experiment. Do not ask the user for input.",
    "- Stay inside the current workspace/worktree.",
    "- Prefer minimal diffs and reversible changes.",
    "- Avoid network-dependent changes unless already required by the existing project workflow.",
    "",
    `Candidate title: ${candidate.title}`,
    `Candidate summary: ${candidate.summary}`,
    `Source: ${candidate.source}`,
    `Recurrence count: ${candidate.recurrenceCount}`,
    "",
    "Evidence:",
  ];

  for (const evidence of candidate.evidence.slice(-5)) {
    lines.push(`- [${evidence.type}] ${evidence.summary}`);
    if (evidence.details) {
      lines.push(`  Details: ${evidence.details}`);
    }
    if (evidence.taskId) {
      lines.push(`  Task: ${evidence.taskId}`);
    }
  }

  lines.push("");
  lines.push("When you finish, include:");
  lines.push("- the reproduction method you used");
  lines.push("- the verification steps you ran");
  lines.push("- whether the issue appears fixed");

  return lines.join("\n");
}

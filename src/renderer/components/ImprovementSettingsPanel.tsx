import { useEffect, useMemo, useState } from "react";
import type {
  ImprovementCandidate,
  ImprovementLoopSettings,
  ImprovementRun,
  Workspace,
} from "../../shared/types";

const DEFAULT_SETTINGS: ImprovementLoopSettings = {
  enabled: false,
  autoRun: true,
  includeDevLogs: true,
  intervalMinutes: 24 * 60,
  maxConcurrentExperiments: 1,
  maxOpenCandidatesPerWorkspace: 25,
  requireWorktree: true,
  reviewRequired: true,
  promotionMode: "github_pr",
  evalWindowDays: 14,
};

export function ImprovementSettingsPanel(props?: { initialWorkspaceId?: string }) {
  const [settings, setSettings] = useState<ImprovementLoopSettings>(DEFAULT_SETTINGS);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [candidates, setCandidates] = useState<ImprovementCandidate[]>([]);
  const [runs, setRuns] = useState<ImprovementRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const pendingReviewRuns = useMemo(
    () =>
      runs.filter(
        (run) =>
          run.status === "passed" &&
          (run.reviewStatus === "pending" || run.promotionStatus === "promotion_failed"),
      ),
    [runs],
  );
  const recentPromotedRuns = useMemo(
    () =>
      [...runs]
        .filter((run) => run.promotionStatus === "merged" || run.promotionStatus === "pr_opened")
        .sort((a, b) => (b.promotedAt || b.createdAt) - (a.promotedAt || a.createdAt))
        .slice(0, 5),
    [runs],
  );

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    void refreshWorkspaceData(selectedWorkspaceId);
  }, [selectedWorkspaceId]);

  const loadAll = async () => {
    try {
      setLoading(true);
      const [nextSettings, nextWorkspaces, tempWorkspace] = await Promise.all([
        window.electronAPI.getImprovementSettings().catch(() => DEFAULT_SETTINGS),
        window.electronAPI.listWorkspaces().catch(() => [] as Workspace[]),
        window.electronAPI.getTempWorkspace().catch(() => null as Workspace | null),
      ]);
      const combined: Workspace[] = [
        ...(tempWorkspace ? [tempWorkspace] : []),
        ...nextWorkspaces.filter((workspace) => workspace.id !== tempWorkspace?.id),
      ];
      setSettings(nextSettings);
      setWorkspaces(combined);
      const preferred = props?.initialWorkspaceId || combined[0]?.id || "";
      setSelectedWorkspaceId(preferred);
      if (preferred) {
        await refreshWorkspaceData(preferred);
      }
    } finally {
      setLoading(false);
    }
  };

  const refreshWorkspaceData = async (workspaceId: string) => {
    const [nextCandidates, nextRuns] = await Promise.all([
      window.electronAPI.listImprovementCandidates(workspaceId),
      window.electronAPI.listImprovementRuns(workspaceId),
    ]);
    setCandidates(nextCandidates);
    setRuns(nextRuns);
  };

  const saveSettings = async (updates: Partial<ImprovementLoopSettings>) => {
    const next = { ...settings, ...updates };
    setSettings(next);
    try {
      setBusy(true);
      await window.electronAPI.saveImprovementSettings(next);
    } finally {
      setBusy(false);
    }
  };

  const refreshCandidates = async () => {
    try {
      setBusy(true);
      await window.electronAPI.refreshImprovementCandidates();
      if (selectedWorkspaceId) {
        await refreshWorkspaceData(selectedWorkspaceId);
      }
    } finally {
      setBusy(false);
    }
  };

  const runNextExperiment = async () => {
    try {
      setBusy(true);
      await window.electronAPI.runNextImprovementExperiment();
      if (selectedWorkspaceId) {
        await refreshWorkspaceData(selectedWorkspaceId);
      }
    } finally {
      setBusy(false);
    }
  };

  const dismissCandidate = async (candidateId: string) => {
    try {
      setBusy(true);
      await window.electronAPI.dismissImprovementCandidate(candidateId);
      if (selectedWorkspaceId) {
        await refreshWorkspaceData(selectedWorkspaceId);
      }
    } finally {
      setBusy(false);
    }
  };

  const reviewRun = async (runId: string, reviewStatus: "accepted" | "dismissed") => {
    try {
      setBusy(true);
      await window.electronAPI.reviewImprovementRun(runId, reviewStatus);
      if (selectedWorkspaceId) {
        await refreshWorkspaceData(selectedWorkspaceId);
      }
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="settings-section">
        <div className="settings-loading">Loading self-improvement settings...</div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Self-Improvement</h2>
      <p className="settings-section-description">
        Mine recurring failures, run branch-isolated repair experiments, and promote successful runs
        through a review queue that can either merge directly or open a GitHub pull request.
      </p>

      <div className="settings-subsection">
        <h3>Loop Settings</h3>

        <ToggleRow
          label="Enable Self-Improvement Loop"
          description="Allow Cowork to build a backlog of recurring failures and run repair experiments."
          checked={settings.enabled}
          disabled={busy}
          onChange={(checked) => void saveSettings({ enabled: checked })}
        />
        <ToggleRow
          label="Auto-Run Experiments"
          description="Pick the highest-priority candidate on a schedule and launch one autonomous experiment."
          checked={settings.autoRun}
          disabled={busy || !settings.enabled}
          onChange={(checked) => void saveSettings({ autoRun: checked })}
        />
        <ToggleRow
          label="Require Worktree Isolation"
          description="Fail experiments fast when Cowork cannot create an isolated git worktree."
          checked={settings.requireWorktree}
          disabled={busy || !settings.enabled}
          onChange={(checked) => void saveSettings({ requireWorktree: checked })}
        />
        <ToggleRow
          label="Include Dev Logs"
          description="Parse `logs/dev-latest.log` when looking for recurring local runtime failures."
          checked={settings.includeDevLogs}
          disabled={busy || !settings.enabled}
          onChange={(checked) => void saveSettings({ includeDevLogs: checked })}
        />
        <ToggleRow
          label="Manual Review Required"
          description="Keep successful experiments in a review queue until you accept or dismiss them."
          checked={settings.reviewRequired}
          disabled={busy || !settings.enabled}
          onChange={(checked) => void saveSettings({ reviewRequired: checked })}
        />
        <SelectRow
          label="Promotion Mode"
          value={settings.promotionMode}
          disabled={busy || !settings.enabled}
          options={[
            { value: "github_pr", label: "Open GitHub PR" },
            { value: "merge", label: "Merge to Base Branch" },
          ]}
          onChange={(value) =>
            void saveSettings({ promotionMode: value as ImprovementLoopSettings["promotionMode"] })
          }
        />

        <NumberRow
          label="Run Interval (minutes)"
          value={settings.intervalMinutes}
          disabled={busy || !settings.enabled}
          min={15}
          max={10080}
          onChange={(value) => void saveSettings({ intervalMinutes: value })}
        />
        <NumberRow
          label="Eval Window (days)"
          value={settings.evalWindowDays}
          disabled={busy || !settings.enabled}
          min={1}
          max={90}
          onChange={(value) => void saveSettings({ evalWindowDays: value })}
        />
      </div>

      <div className="settings-subsection">
        <h3>Review Queue</h3>
        {pendingReviewRuns.length === 0 ? (
          <p className="settings-form-hint">No successful experiments are waiting for review.</p>
        ) : (
          pendingReviewRuns.map((run) => (
            <div key={run.id} className="settings-form-group">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
                    {run.verdictSummary || "Successful improvement experiment"}
                  </div>
                  <p className="settings-form-hint" style={{ margin: "4px 0 0 0" }}>
                    Task: <code>{run.taskId || "pending"}</code>
                    {run.branchName ? (
                      <>
                        {" "}
                        | Branch: <code>{run.branchName}</code>
                      </>
                    ) : null}
                    {" "} | Promotion: <code>{run.promotionStatus || "idle"}</code>
                  </p>
                  {run.pullRequest?.url ? (
                    <p className="settings-form-hint" style={{ margin: "6px 0 0 0" }}>
                      PR:{" "}
                      <a href={run.pullRequest.url} target="_blank" rel="noreferrer">
                        {run.pullRequest.url}
                      </a>
                    </p>
                  ) : null}
                  {run.promotionError ? (
                    <p className="settings-form-hint" style={{ margin: "6px 0 0 0", color: "var(--color-danger)" }}>
                      {run.promotionError}
                    </p>
                  ) : null}
                  {run.evaluationNotes ? (
                    <p className="settings-form-hint" style={{ margin: "6px 0 0 0" }}>
                      {run.evaluationNotes}
                    </p>
                  ) : null}
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button
                    className="settings-button"
                    onClick={() => void reviewRun(run.id, "accepted")}
                    disabled={busy}
                  >
                    {run.promotionStatus === "promotion_failed"
                      ? settings.promotionMode === "github_pr"
                        ? "Retry PR"
                        : "Retry Merge"
                      : settings.promotionMode === "github_pr"
                        ? "Accept + Open PR"
                        : "Accept + Merge"}
                  </button>
                  <button
                    className="settings-button settings-button-secondary"
                    onClick={() => void reviewRun(run.id, "dismissed")}
                    disabled={busy}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="settings-subsection">
        <h3>Recent Promotions</h3>
        {recentPromotedRuns.length === 0 ? (
          <p className="settings-form-hint">No improvements have been promoted yet.</p>
        ) : (
          recentPromotedRuns.map((run) => (
            <div key={run.id} className="settings-form-group">
              <div style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
                {run.verdictSummary || "Promoted improvement run"}
              </div>
              <p className="settings-form-hint" style={{ margin: "4px 0 0 0" }}>
                Status: <code>{run.promotionStatus || "idle"}</code>
                {run.pullRequest?.number ? (
                  <>
                    {" "}
                    | PR: <code>#{run.pullRequest.number}</code>
                  </>
                ) : null}
                {run.mergeResult?.mergeSha ? (
                  <>
                    {" "}
                    | Merge: <code>{run.mergeResult.mergeSha.slice(0, 10)}</code>
                  </>
                ) : null}
              </p>
              {run.pullRequest?.url ? (
                <p className="settings-form-hint" style={{ margin: "6px 0 0 0" }}>
                  <a href={run.pullRequest.url} target="_blank" rel="noreferrer">
                    {run.pullRequest.url}
                  </a>
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="settings-subsection">
        <div
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
        >
          <div>
            <h3 style={{ marginBottom: 4 }}>Workspace Candidates</h3>
            <p className="settings-form-hint" style={{ margin: 0 }}>
              Review the current improvement backlog and launch the next experiment manually.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="settings-button" onClick={() => void refreshCandidates()} disabled={busy}>
              Refresh Signals
            </button>
            <button
              className="settings-button"
              onClick={() => void runNextExperiment()}
              disabled={busy || !settings.enabled}
            >
              Run Next Experiment
            </button>
          </div>
        </div>

        {workspaces.length > 0 ? (
          <div className="settings-form-group">
            <label className="settings-label">Workspace</label>
            <select
              value={selectedWorkspaceId}
              onChange={(event) => setSelectedWorkspaceId(event.target.value)}
              className="settings-select"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {candidates.length === 0 ? (
          <p className="settings-form-hint">No candidates detected for this workspace yet.</p>
        ) : (
          candidates.map((candidate) => (
            <div key={candidate.id} className="settings-form-group">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
                    {candidate.title}
                  </div>
                  <p className="settings-form-hint" style={{ margin: "4px 0 0 0" }}>
                    {candidate.summary}
                  </p>
                  <p className="settings-form-hint" style={{ margin: "6px 0 0 0" }}>
                    Source: <code>{candidate.source}</code> | Status: <code>{candidate.status}</code> |
                    Priority: <code>{candidate.priorityScore.toFixed(2)}</code> | Recurrence:{" "}
                    <code>{candidate.recurrenceCount}</code>
                  </p>
                </div>
                <div style={{ flexShrink: 0 }}>
                  {candidate.status !== "dismissed" ? (
                    <button
                      className="settings-button settings-button-secondary"
                      onClick={() => void dismissCandidate(candidate.id)}
                      disabled={busy}
                    >
                      Dismiss
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ToggleRow(props: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="settings-form-group">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{props.label}</div>
          <p className="settings-form-hint" style={{ marginTop: 4, marginBottom: 0 }}>
            {props.description}
          </p>
        </div>
        <label className="settings-toggle" style={{ flexShrink: 0, marginTop: 2 }}>
          <input
            type="checkbox"
            checked={props.checked}
            disabled={props.disabled}
            onChange={(event) => props.onChange(event.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
      </div>
    </div>
  );
}

function NumberRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="settings-form-group">
      <label className="settings-label">{props.label}</label>
      <input
        type="number"
        className="settings-input"
        min={props.min}
        max={props.max}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.target.value) || props.min)}
      />
    </div>
  );
}

function SelectRow(props: {
  label: string;
  value: string;
  disabled?: boolean;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings-form-group">
      <label className="settings-label">{props.label}</label>
      <select
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        className="settings-select"
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

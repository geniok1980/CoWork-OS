import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityFeed } from "../ActivityFeed";
import { MentionInput } from "../MentionInput";
import { MentionList } from "../MentionList";
import { BOARD_COLUMNS } from "./useMissionControlData";
import type { MissionControlData } from "./useMissionControlData";
import type {
  EvidenceRef,
  TaskLearningProgress,
  UnifiedRecallResult,
  UnifiedRecallSourceType,
} from "../../../shared/types";

interface MCTaskDetailProps {
  data: MissionControlData;
  taskId: string;
}

const UNIFIED_RECALL_SOURCES: Array<{ value: UnifiedRecallSourceType; label: string }> = [
  { value: "task", label: "Tasks" },
  { value: "message", label: "Messages" },
  { value: "file", label: "Files" },
  { value: "workspace_note", label: "Workspace notes" },
  { value: "memory", label: "Memory" },
  { value: "knowledge_graph", label: "Knowledge graph" },
];

function statusTone(status: string): string {
  return `status-${status.replace(/[^a-z0-9_-]/gi, "-")}`;
}

function renderEvidenceLabel(ref: EvidenceRef): string {
  const prefix = ref.sourceType === "file" ? "File" : ref.sourceType === "url" ? "Link" : "Evidence";
  return ref.snippet ? `${prefix}: ${ref.snippet}` : `${prefix}: ${ref.sourceUrlOrPath}`;
}

export function MCTaskDetail({ data, taskId }: MCTaskDetailProps) {
  const {
    tasks,
    agents,
    selectedWorkspaceId,
    handleAssignTask,
    handleMoveTask,
    getMissionColumnForTask,
    commentText,
    setCommentText,
    postingComment,
    handlePostComment,
    formatRelativeTime,
    agentContext,
    isAllWorkspacesSelected,
    getWorkspaceName,
  } = data;

  const task = tasks.find((t) => t.id === taskId);
  const [learningProgress, setLearningProgress] = useState<TaskLearningProgress[]>([]);
  const [learningLoading, setLearningLoading] = useState(false);
  const [learningError, setLearningError] = useState<string | null>(null);
  const [recallQuery, setRecallQuery] = useState("");
  const [recallSource, setRecallSource] = useState<UnifiedRecallSourceType | "">("");
  const [recallResults, setRecallResults] = useState<UnifiedRecallResult[]>([]);
  const [recallLoading, setRecallLoading] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);

  const taskWorkspaceId = task?.workspaceId || selectedWorkspaceId || undefined;

  const loadLearningProgress = useCallback(async () => {
    if (!task?.id || !window.electronAPI?.getTaskLearningProgress) return;
    setLearningLoading(true);
    try {
      const progress = await window.electronAPI.getTaskLearningProgress(task.id);
      setLearningProgress(progress || []);
      setLearningError(null);
    } catch (error) {
      console.error("Failed to load task learning progress:", error);
      setLearningError("Unable to load learning progress.");
    } finally {
      setLearningLoading(false);
    }
  }, [task?.id]);

  const loadRecall = useCallback(async () => {
    if (!window.electronAPI?.queryUnifiedRecall) return;
    const query = recallQuery.trim();
    if (!query) {
      setRecallResults([]);
      setRecallError(null);
      return;
    }

    setRecallLoading(true);
    try {
      const response = await window.electronAPI.queryUnifiedRecall({
        workspaceId: taskWorkspaceId,
        query,
        limit: 12,
        ...(recallSource ? { sourceTypes: [recallSource] } : {}),
      });
      setRecallResults(response.results || []);
      setRecallError(null);
    } catch (error) {
      console.error("Failed to query unified recall:", error);
      setRecallError("Unable to search Cowork memory.");
    } finally {
      setRecallLoading(false);
    }
  }, [recallQuery, recallSource, taskWorkspaceId]);

  useEffect(() => {
    void loadLearningProgress();
  }, [loadLearningProgress]);

  useEffect(() => {
    if (!window.electronAPI?.onTaskLearningEvent || !task?.id) return;

    const unsubscribe = window.electronAPI.onTaskLearningEvent((event) => {
      if (event.taskId !== task.id) return;
      setLearningProgress((prev) => {
        const withoutEvent = prev.filter((item) => item.id !== event.id);
        return [event, ...withoutEvent].sort((a, b) => b.completedAt - a.completedAt);
      });
      setLearningError(null);
    });

    return unsubscribe;
  }, [task?.id]);

  if (!task) return <div className="mc-v2-empty">{agentContext.getUiCopy("mcTaskEmpty")}</div>;

  const visibleLearningProgress = useMemo(
    () => [...learningProgress].sort((a, b) => b.completedAt - a.completedAt),
    [learningProgress],
  );

  return (
    <>
      <div>
        <div className="mc-v2-task-detail-title">
          <h3>{task.title}</h3>
          {isAllWorkspacesSelected && (
            <span className="mc-v2-workspace-tag">{getWorkspaceName(task.workspaceId)}</span>
          )}
          <span className={`mc-v2-status-pill status-${task.status}`}>{task.status.replace("_", " ")}</span>
        </div>
        <div className="mc-v2-detail-updated">
          {agentContext.getUiCopy("mcTaskUpdatedAt", { time: formatRelativeTime(task.updatedAt) })}
        </div>
      </div>

      <div className="mc-v2-detail-meta">
        <label>
          {agentContext.getUiCopy("mcTaskAssigneeLabel")}
          <select
            value={task.assignedAgentRoleId || ""}
            onChange={(e) => handleAssignTask(task.id, e.target.value || null)}
          >
            <option value="">{agentContext.getUiCopy("mcTaskUnassigned")}</option>
            {agents.filter((a) => a.isActive).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          {agentContext.getUiCopy("mcTaskStageLabel")}
          <select value={getMissionColumnForTask(task)} onChange={(e) => handleMoveTask(task.id, e.target.value)}>
            {BOARD_COLUMNS.map((col) => (
              <option key={col.id} value={col.id}>
                {col.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mc-v2-detail-section">
        <h4>{agentContext.getUiCopy("mcTaskBriefTitle")}</h4>
        <p className="mc-v2-detail-brief">{task.prompt}</p>
      </div>

      <div className="mc-v2-detail-section mc-v2-learning-section">
        <div className="mc-v2-section-header">
          <h4>What Cowork learned</h4>
          <span className="mc-v2-section-hint">
            Memory, playbook, and skill promotion are tracked here after every task.
          </span>
        </div>
        {learningLoading && learningProgress.length === 0 ? (
          <div className="mc-v2-empty">Loading task learning progress...</div>
        ) : learningError ? (
          <div className="mc-v2-error">{learningError}</div>
        ) : visibleLearningProgress.length > 0 ? (
          <div className="mc-v2-learning-list">
            {visibleLearningProgress.map((progress) => (
              <article key={progress.id} className="mc-v2-learning-card">
                <div className="mc-v2-learning-card-header">
                  <div>
                    <div className="mc-v2-learning-outcome">
                      <span className={`mc-v2-status-pill ${statusTone(progress.outcome)}`}>{progress.outcome.replace("_", " ")}</span>
                      <span className="mc-v2-learning-time">{formatRelativeTime(progress.completedAt)}</span>
                    </div>
                    <h5>{progress.summary}</h5>
                  </div>
                  <div className="mc-v2-learning-next">
                    <span>Next</span>
                    <strong>{progress.nextAction || "No follow-up required"}</strong>
                  </div>
                </div>

                <div className="mc-v2-learning-steps">
                  {progress.steps.map((step) => (
                    <section key={`${progress.id}:${step.stage}`} className={`mc-v2-learning-step mc-v2-learning-step-${step.status}`}>
                      <div className="mc-v2-learning-step-header">
                        <strong>{step.title}</strong>
                        <span className={`mc-v2-status-pill ${statusTone(step.status)}`}>{step.status}</span>
                      </div>
                      <p>{step.summary}</p>
                      {step.relatedIds && (
                        <div className="mc-v2-learning-related">
                          {step.relatedIds.memoryId && <span>Memory: {step.relatedIds.memoryId}</span>}
                          {step.relatedIds.proposalId && <span>Proposal: {step.relatedIds.proposalId}</span>}
                          {step.relatedIds.skillId && <span>Skill: {step.relatedIds.skillId}</span>}
                        </div>
                      )}
                      {step.evidenceRefs.length > 0 && (
                        <ul className="mc-v2-learning-evidence">
                          {step.evidenceRefs.map((ref) => (
                            <li key={ref.evidenceId}>
                              <span className="mc-v2-learning-evidence-source">{ref.sourceType}</span>
                              <span>{renderEvidenceLabel(ref)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="mc-v2-empty">No learning progress has been recorded for this task yet.</div>
        )}
      </div>

      <div className="mc-v2-detail-section mc-v2-recall-section">
        <div className="mc-v2-section-header">
          <h4>Search everything</h4>
          <span className="mc-v2-section-hint">
            Tasks, messages, files, workspace notes, memory, and knowledge graph.
          </span>
        </div>
        <form
          className="mc-v2-recall-search"
          onSubmit={(event) => {
            event.preventDefault();
            void loadRecall();
          }}
        >
          <input
            type="search"
            className="mc-v2-recall-input"
            placeholder="Search Cowork memory, tasks, messages, and files"
            value={recallQuery}
            onChange={(e) => setRecallQuery(e.target.value)}
          />
          <select
            className="mc-v2-recall-source"
            value={recallSource}
            onChange={(e) => setRecallSource(e.target.value as UnifiedRecallSourceType | "")}
          >
            <option value="">All sources</option>
            {UNIFIED_RECALL_SOURCES.map((source) => (
              <option key={source.value} value={source.value}>
                {source.label}
              </option>
            ))}
          </select>
          <button type="submit" className="mc-v2-recall-submit" disabled={recallLoading}>
            {recallLoading ? "Searching..." : "Search"}
          </button>
        </form>
        {recallError && <div className="mc-v2-error">{recallError}</div>}
        {recallResults.length > 0 ? (
          <div className="mc-v2-recall-results">
            {recallResults.map((result) => (
              <article key={`${result.sourceType}:${result.objectId}`} className="mc-v2-recall-result">
                <div className="mc-v2-recall-result-header">
                  <div>
                    <strong>{result.title || result.sourceLabel || result.sourceType}</strong>
                    <div className="mc-v2-recall-result-meta">
                      <span>{result.sourceLabel || result.sourceType}</span>
                      <span>{formatRelativeTime(result.timestamp)}</span>
                      {typeof result.rank === "number" && <span>Rank {result.rank.toFixed(2)}</span>}
                    </div>
                  </div>
                  <span className="mc-v2-status-pill status-info">{result.sourceType}</span>
                </div>
                <p>{result.snippet}</p>
                {result.workspaceId && (
                  <div className="mc-v2-recall-result-foot">
                    Workspace: {getWorkspaceName(result.workspaceId)}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="mc-v2-empty">
            {recallLoading
              ? "Searching Cowork memory..."
              : "Search everything to pull a single unified result list across tasks, messages, files, notes, memory, and the knowledge graph."}
          </div>
        )}
      </div>

      <div className="mc-v2-detail-section">
        <h4>{agentContext.getUiCopy("mcTaskUpdatesTitle")}</h4>
        {taskWorkspaceId && (
          <ActivityFeed workspaceId={taskWorkspaceId} taskId={task.id} compact maxItems={20} showFilters={false} />
        )}
        <div className="mc-v2-comment-box">
          <textarea
            placeholder={agentContext.getUiCopy("mcTaskUpdatePlaceholder")}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            rows={3}
          />
          <button
            className="mc-v2-comment-submit"
            onClick={handlePostComment}
            disabled={postingComment || commentText.trim().length === 0}
          >
            {postingComment ? agentContext.getUiCopy("mcTaskPosting") : agentContext.getUiCopy("mcTaskPostUpdate")}
          </button>
        </div>
      </div>

      <div className="mc-v2-detail-section">
        <h4>{agentContext.getUiCopy("mcTaskMentionsTitle")}</h4>
        {taskWorkspaceId && (
          <>
            <MentionInput
              workspaceId={taskWorkspaceId}
              taskId={task.id}
              placeholder={agentContext.getUiCopy("mcTaskMentionPlaceholder")}
            />
            <MentionList workspaceId={taskWorkspaceId} taskId={task.id} />
          </>
        )}
      </div>
    </>
  );
}

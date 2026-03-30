import { BOARD_COLUMNS } from "./useMissionControlData";
import type { MissionControlData } from "./useMissionControlData";

interface MCBoardTabProps {
  data: MissionControlData;
}

export function MCBoardTab({ data }: MCBoardTabProps) {
  const {
    getTasksByColumn, getAgent, detailPanel, setDetailPanel,
    handleMoveTask, dragOverColumn, setDragOverColumn,
    formatRelativeTime, agentContext, isAllWorkspacesSelected, getWorkspaceName,
  } = data;

  const selectedTaskId = detailPanel?.kind === "task" ? detailPanel.taskId : null;

  return (
    <div className="mc-v2-board">
      <div className="mc-v2-board-header">
        <h2>{agentContext.getUiCopy("mcMissionQueueTitle")}</h2>
      </div>
      <div className="mc-v2-kanban">
        {BOARD_COLUMNS.map((column) => {
          const columnTasks = getTasksByColumn(column.id);
          return (
            <div
              key={column.id}
              className={`mc-v2-kanban-column ${dragOverColumn === column.id ? "drag-over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragOverColumn(column.id); }}
              onDragLeave={() => setDragOverColumn(null)}
              onDrop={(e) => {
                e.preventDefault();
                const taskId = e.dataTransfer.getData("text/plain");
                if (taskId) handleMoveTask(taskId, column.id);
                setDragOverColumn(null);
              }}
            >
              <div className="mc-v2-column-header">
                <span className="mc-v2-column-dot" style={{ backgroundColor: column.color }}></span>
                <span className="mc-v2-column-label">{column.label}</span>
                <span className="mc-v2-column-count">{columnTasks.length}</span>
              </div>
              <div className="mc-v2-column-tasks">
                {columnTasks.map((task) => {
                  const assignedAgent = getAgent(task.assignedAgentRoleId);
                  return (
                    <div
                      key={task.id}
                      className={`mc-v2-task-card ${selectedTaskId === task.id ? "selected" : ""}`}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData("text/plain", task.id); e.dataTransfer.effectAllowed = "move"; }}
                      onClick={() => setDetailPanel({ kind: "task", taskId: task.id })}
                    >
                      <div className="mc-v2-task-title">{task.title}</div>
                      {isAllWorkspacesSelected && (
                        <div className="mc-v2-task-workspace">{getWorkspaceName(task.workspaceId)}</div>
                      )}
                      {assignedAgent && (
                        <div className="mc-v2-task-assignee">
                          <span className="mc-v2-task-assignee-avatar" style={{ backgroundColor: assignedAgent.color }}>
                            {assignedAgent.icon}
                          </span>
                          <span className="mc-v2-task-assignee-name">{assignedAgent.displayName}</span>
                        </div>
                      )}
                      <div className="mc-v2-task-meta">
                        <span className={`mc-v2-status-pill status-${task.status}`}>{task.status.replace("_", " ")}</span>
                        <span className="mc-v2-task-time">{formatRelativeTime(task.updatedAt)}</span>
                      </div>
                    </div>
                  );
                })}
                {columnTasks.length === 0 && (
                  <div className="mc-v2-column-empty">{agentContext.getUiCopy("mcColumnEmpty")}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

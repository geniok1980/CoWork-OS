import type { TaskOutputSummary, ToastNotification } from "../../shared/types";
import { getPrimaryOutputFileName, hasTaskOutputs } from "./task-outputs";

export interface CompletionViewContext {
  isMainView: boolean;
  isSelectedTask: boolean;
  panelCollapsed: boolean;
}

export interface CompletionPanelDecision {
  autoOpenPanel: boolean;
  markUnseenOutput: boolean;
}

export interface CompletionToastActionDependencies {
  resolveWorkspacePath: () => Promise<string | undefined>;
  openFile: (path: string, workspacePath?: string) => Promise<string | undefined | null>;
  showInFinder: (path: string, workspacePath?: string) => Promise<void>;
  onViewInFiles: () => void;
  onOpenFileError?: (error: unknown) => void;
  onShowInFinderError?: (error: unknown) => void;
}

export function buildCompletionOutputMessage(summary: TaskOutputSummary): string {
  const primaryOutputName = getPrimaryOutputFileName(summary);
  if (summary.outputCount === 1) {
    return `1 output ready: ${primaryOutputName || "output file"}`;
  }
  return `${summary.outputCount} outputs ready${primaryOutputName ? ` · primary: ${primaryOutputName}` : ""}`;
}

export function shouldTrackUnseenCompletion(context: Pick<CompletionViewContext, "isMainView" | "isSelectedTask">): boolean {
  return !(context.isMainView && context.isSelectedTask);
}

export function decideCompletionPanelBehavior(context: CompletionViewContext): CompletionPanelDecision {
  if (context.isMainView && context.isSelectedTask && context.panelCollapsed) {
    return { autoOpenPanel: true, markUnseenOutput: false };
  }
  if (!context.isMainView || context.panelCollapsed || !context.isSelectedTask) {
    return { autoOpenPanel: false, markUnseenOutput: true };
  }
  return { autoOpenPanel: false, markUnseenOutput: false };
}

export function addUniqueTaskId(taskIds: string[], taskId: string): string[] {
  return taskIds.includes(taskId) ? taskIds : [...taskIds, taskId];
}

export function removeTaskId(taskIds: string[], taskId: string): string[] {
  return taskIds.filter((id) => id !== taskId);
}

export function shouldClearUnseenOutputBadges(isMainView: boolean, rightPanelCollapsed: boolean): boolean {
  return isMainView && !rightPanelCollapsed;
}

export function createCompletionOutputToastActions(
  primaryOutputPath: string | undefined,
  dependencies: CompletionToastActionDependencies,
): NonNullable<ToastNotification["actions"]> {
  return [
    {
      label: "Open file",
      callback: async () => {
        if (!primaryOutputPath) return;
        const workspacePath = await dependencies.resolveWorkspacePath();
        const openError = await dependencies.openFile(primaryOutputPath, workspacePath);
        if (openError) {
          dependencies.onOpenFileError?.(openError);
        }
      },
    },
    {
      label: "Show in Finder",
      variant: "secondary",
      callback: async () => {
        if (!primaryOutputPath) return;
        try {
          const workspacePath = await dependencies.resolveWorkspacePath();
          await dependencies.showInFinder(primaryOutputPath, workspacePath);
        } catch (error) {
          dependencies.onShowInFinderError?.(error);
        }
      },
    },
    {
      label: "View in Files",
      variant: "secondary",
      callback: () => {
        dependencies.onViewInFiles();
      },
    },
  ];
}

export function buildTaskCompletionToast(options: {
  taskId: string;
  taskTitle?: string;
  outputSummary?: TaskOutputSummary | null;
  actionDependencies?: CompletionToastActionDependencies;
  terminalStatus?:
    | "ok"
    | "partial_success"
    | "needs_user_action"
    | "awaiting_approval"
    | "resume_available"
    | "failed"
    | string;
}): Omit<ToastNotification, "id"> {
  const { taskId, taskTitle, outputSummary, actionDependencies, terminalStatus } = options;
  const isNeedsUserAction =
    terminalStatus === "needs_user_action" || terminalStatus === "awaiting_approval";
  const isWarningCompletion =
    isNeedsUserAction || terminalStatus === "partial_success" || terminalStatus === "resume_available";
  const title = terminalStatus === "awaiting_approval"
    ? "Task waiting for approval"
    : terminalStatus === "resume_available"
      ? "Task paused - resume available"
      : isNeedsUserAction
    ? "Task complete - action required"
    : isWarningCompletion
      ? "Task complete (warnings)"
      : "Task complete";
  const toastType: ToastNotification["type"] = isWarningCompletion ? "warning" : "success";

  if (hasTaskOutputs(outputSummary)) {
    const actions = actionDependencies
      ? createCompletionOutputToastActions(outputSummary.primaryOutputPath, actionDependencies)
      : undefined;
    return {
      type: toastType,
      title,
      message: buildCompletionOutputMessage(outputSummary),
      taskId,
      ...(actions && actions.length > 0 ? { actions } : {}),
    };
  }

  return {
    type: toastType,
    title,
    message: taskTitle || "Task finished successfully",
    taskId,
  };
}

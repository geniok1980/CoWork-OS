/**
 * Single active computer-use session: overlay, isolation, shortcuts, per-app permissions.
 */

import type { BrowserWindow } from "electron";
import { AppPermissionManager } from "../security/app-permission-manager";
import { classifyApp, formatAccessLevelForUi } from "./app-risk-profile";
import { CUASafetyOverlay } from "./safety-overlay";
import { WindowIsolation } from "./window-isolation";
import { ShortcutGuard } from "./shortcut-guard";

export type ComputerUseSessionEndReason = "completed" | "aborted" | "manual";

export type ComputerUseSessionEvent =
  | { type: "session_started"; taskId: string }
  | {
      type: "session_ended";
      taskId: string;
      reason: ComputerUseSessionEndReason;
    };

/** Minimal daemon surface to avoid circular imports with AgentDaemon. */
export interface ComputerUseDaemonLike {
  requestApproval(
    taskId: string,
    approvalType: string,
    description: string,
    details: Record<string, unknown>,
    opts?: { allowAutoApprove?: boolean },
  ): Promise<boolean>;
  logEvent(taskId: string, eventType: string, payload: Record<string, unknown>): void;
}

export class ComputerUseSessionManager {
  private static instance: ComputerUseSessionManager | null = null;

  static getInstance(): ComputerUseSessionManager {
    if (!ComputerUseSessionManager.instance) {
      ComputerUseSessionManager.instance = new ComputerUseSessionManager();
    }
    return ComputerUseSessionManager.instance;
  }

  /** Test-only reset */
  static resetForTesting(): void {
    ComputerUseSessionManager.instance = null;
  }

  private activeTaskId: string | null = null;
  private daemon: ComputerUseDaemonLike | null = null;
  private appPermissionManager: AppPermissionManager | null = null;
  private readonly overlay = new CUASafetyOverlay();
  private readonly isolation = new WindowIsolation();
  private readonly shortcutGuard = new ShortcutGuard();
  private aborted = false;
  private mainWindowGetter: (() => BrowserWindow | null) | null = null;
  private mainWindowWasVisible = false;
  private notifyHandler: ((e: ComputerUseSessionEvent) => void) | null = null;

  private constructor() {}

  setMainWindowGetter(getter: () => BrowserWindow | null): void {
    this.mainWindowGetter = getter;
  }

  setNotifyHandler(handler: ((e: ComputerUseSessionEvent) => void) | null): void {
    this.notifyHandler = handler;
  }

  getActiveTaskId(): string | null {
    return this.activeTaskId;
  }

  /** Active session's permission map, if any. */
  getAppPermissionManagerOrNull(): AppPermissionManager | null {
    return this.appPermissionManager;
  }

  isAborted(): boolean {
    return this.aborted;
  }

  /**
   * Begin or continue a session for this task. Throws if another task holds the lock.
   */
  acquire(taskId: string, daemon: ComputerUseDaemonLike): AppPermissionManager {
    if (this.activeTaskId && this.activeTaskId !== taskId) {
      throw new Error(
        "Computer use is already active for another task. Finish or cancel that task first.",
      );
    }

    if (!this.activeTaskId) {
      this.activeTaskId = taskId;
      this.daemon = daemon;
      this.aborted = false;

      const pm = new AppPermissionManager(`cua-session-${taskId}-${Date.now()}`);
      pm.onPermissionRequest = async (request) => {
        const profile = classifyApp(request.bundleId || "", request.appName);
        const description = `Allow ${formatAccessLevelForUi(request.requestedLevel)} for "${request.appName}" this session?`;
        const approved = await daemon.requestApproval(
          taskId,
          "computer_use",
          description,
          {
            kind: "computer_use_app_grant",
            appName: request.appName,
            bundleId: request.bundleId,
            requestedLevel: request.requestedLevel,
            reason: request.reason,
            riskClass: profile.riskClass,
            maxSuggestedLevel: profile.maxSuggestedLevel,
            sentinelWarning: profile.sentinelWarning,
          },
          { allowAutoApprove: false },
        );
        return approved ? request.requestedLevel : "denied";
      };

      this.appPermissionManager = pm;

      this.overlay.show();
      this.overlay.updateStatus("Preparing…");

      this.shortcutGuard.enable(() => {
        void this.abortSession(taskId);
      });

      const mw = this.mainWindowGetter?.() ?? null;
      if (mw && !mw.isDestroyed() && mw.isVisible()) {
        this.mainWindowWasVisible = true;
        mw.hide();
      }

      daemon.logEvent(taskId, "computer_use_session_started", {});
      this.emitNotify({ type: "session_started", taskId });
    }

    return this.appPermissionManager!;
  }

  updateActionStatus(label: string): void {
    if (!this.activeTaskId) return;
    this.overlay.updateStatus(label);
  }

  checkNotAborted(): void {
    if (this.aborted) {
      throw new Error("Computer use was stopped (Esc). Start a new action when ready.");
    }
  }

  /**
   * Re-run window isolation after app list changes (best-effort).
   */
  async refreshIsolation(): Promise<void> {
    if (!this.activeTaskId || !this.appPermissionManager) return;
    const names = this.appPermissionManager.getActivePermissions().map((p) => p.appName);
    if (names.length === 0) return;
    try {
      await this.isolation.isolate(names, { keepHostProcessesVisible: false });
    } catch {
      // isolation is best-effort
    }
  }

  async onAppPermissionGranted(): Promise<void> {
    await this.refreshIsolation();
  }

  endSessionIfOwner(taskId: string, reason: ComputerUseSessionEndReason = "completed"): void {
    if (this.activeTaskId !== taskId) return;
    void this.cleanupInternal(taskId, reason);
  }

  /** User or Esc — abort and tear down */
  async abortSession(taskId: string): Promise<void> {
    if (this.activeTaskId !== taskId) return;
    this.aborted = true;
    this.daemon?.logEvent(taskId, "computer_use_session_aborted", { reason: "escape_or_manual" });
    await this.cleanupInternal(taskId, "aborted");
  }

  async endSessionManual(): Promise<void> {
    if (!this.activeTaskId) return;
    const tid = this.activeTaskId;
    this.daemon?.logEvent(tid, "computer_use_session_ended", { reason: "manual" });
    await this.cleanupInternal(tid, "manual");
  }

  private emitNotify(event: ComputerUseSessionEvent): void {
    try {
      this.notifyHandler?.(event);
    } catch {
      // ignore renderer IPC failures
    }
  }

  private async cleanupInternal(
    taskId: string,
    reason: ComputerUseSessionEndReason,
  ): Promise<void> {
    if (this.activeTaskId !== taskId) return;

    this.shortcutGuard.disable();
    this.overlay.hide();

    try {
      await this.isolation.restore();
    } catch {
      // best-effort
    }

    this.appPermissionManager?.revokeAll();
    this.appPermissionManager = null;

    const mw = this.mainWindowGetter?.() ?? null;
    if (this.mainWindowWasVisible && mw && !mw.isDestroyed()) {
      mw.show();
    }
    this.mainWindowWasVisible = false;

    this.activeTaskId = null;
    const d = this.daemon;
    this.daemon = null;

    if (reason === "completed") {
      d?.logEvent(taskId, "computer_use_session_ended", { reason: "task_finished" });
    }

    this.emitNotify({ type: "session_ended", taskId, reason });
    this.aborted = false;
  }
}

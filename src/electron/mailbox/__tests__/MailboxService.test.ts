import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("MailboxService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let service: import("../MailboxService").MailboxService;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;

  const now = Date.now();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-mailbox-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [{ DatabaseManager }, { MailboxService }] = await Promise.all([
      import("../../database/schema"),
      import("../MailboxService"),
    ]);

    manager = new DatabaseManager();
    db = manager.getDatabase();
    service = new MailboxService(db);

    db.prepare(
      `INSERT INTO mailbox_accounts
        (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail:test@example.com",
      "gmail",
      "test@example.com",
      "Test User",
      "connected",
      JSON.stringify(["threads", "drafts"]),
      null,
      now,
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail-thread:alpha",
      "gmail:test@example.com",
      "alpha",
      "gmail",
      "Q2 launch review",
      "Can you send the revised launch plan by tomorrow and propose times?",
      JSON.stringify([{ email: "alex@acme.com", name: "Alex" }]),
      JSON.stringify(["IMPORTANT"]),
      "priority",
      82,
      76,
      1,
      1,
      0,
      0,
      1,
      2,
      now - 2 * 60 * 60 * 1000,
      now,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:alpha",
      "m-1",
      "incoming",
      "Alex",
      "alex@acme.com",
      JSON.stringify([{ email: "test@example.com", name: "Test User" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Q2 launch review",
      "Need revised plan",
      "Can you send the revised launch plan by tomorrow? Please also propose two meeting times for the review.",
      now - 2 * 60 * 60 * 1000,
      1,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:alpha",
      "m-2",
      "outgoing",
      "Test User",
      "test@example.com",
      JSON.stringify([{ email: "alex@acme.com", name: "Alex" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Re: Q2 launch review",
      "Working on it",
      "Hi Alex,\nI am working on the revised plan now.\n\nThanks,",
      now - 90 * 60 * 1000,
      0,
      JSON.stringify({}),
      now,
      now,
    );

  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("summarizes threads, extracts commitments, and reports queue counts", async () => {
    const summary = await service.summarizeThread("gmail-thread:alpha");
    expect(summary?.summary).toContain("Can you send the revised launch plan");
    expect(summary?.suggestedNextAction).toBe("Draft a reply");

    const commitments = await service.extractCommitments("gmail-thread:alpha");
    expect(commitments.length).toBeGreaterThan(0);
    expect(commitments[0]?.title.toLowerCase()).toContain("revised launch plan");

    const followups = await service.reviewBulkAction({ type: "follow_up", limit: 10 });
    expect(followups.count).toBeGreaterThan(0);
    expect(followups.proposals[0]?.threadId).toBe("gmail-thread:alpha");

    const detail = await service.getThread("gmail-thread:alpha");
    expect(detail?.summary?.keyAsks.length).toBeGreaterThan(0);
    expect(detail?.commitments.length).toBeGreaterThan(0);

    const status = await service.getSyncStatus();
    expect(status.threadCount).toBe(1);
    expect(status.needsReplyCount).toBe(1);
    expect(status.commitmentCount).toBeGreaterThan(0);
  });

  it("stores schedule suggestions in a thread proposal preview", async () => {
    const scheduled = await service.scheduleReply("gmail-thread:alpha");
    expect(scheduled.threadId).toBe("gmail-thread:alpha");
    expect(scheduled.suggestions.length).toBeGreaterThan(0);

    const detail = await service.getThread("gmail-thread:alpha");
    const scheduleProposal = detail?.proposals.find(
      (proposal) => proposal.type === "schedule" && proposal.status === "suggested",
    );

    expect(scheduleProposal).toBeTruthy();
    expect(scheduleProposal?.preview).toMatchObject({
      suggestions: scheduled.suggestions,
    });
    expect(Array.isArray(scheduleProposal?.preview?.slotOptions)).toBe(true);
  });

  it("allows generated drafts to be discarded", async () => {
    const draft = await service.generateDraft("gmail-thread:alpha");
    expect(draft).toBeTruthy();

    await service.applyAction({
      threadId: "gmail-thread:alpha",
      draftId: draft?.id,
      type: "discard_draft",
    });

    const detail = await service.getThread("gmail-thread:alpha");
    expect(detail?.drafts.map((entry) => entry.id)).not.toContain(draft?.id);
    expect(detail?.proposals.some((proposal) => proposal.type === "reply" && proposal.status === "suggested")).toBe(false);
  });

  it("searches sender and body content and computes contact intelligence", async () => {
    const senderMatches = await service.listThreads({ query: "alex@acme.com" });
    expect(senderMatches.map((thread) => thread.id)).toContain("gmail-thread:alpha");

    const bodyMatches = await service.listThreads({ query: "meeting times" });
    expect(bodyMatches.map((thread) => thread.id)).toContain("gmail-thread:alpha");

    const unreadMatches = await service.listThreads({ unreadOnly: true });
    expect(unreadMatches.map((thread) => thread.id)).toContain("gmail-thread:alpha");

    const detail = await service.getThread("gmail-thread:alpha");
    expect(detail?.contactMemory?.recentSubjects).toContain("Q2 launch review");
    expect(detail?.contactMemory?.styleSignals?.length).toBeGreaterThan(0);
    expect(detail?.research?.relationshipSummary).toContain("Average response time");
    expect(detail?.research?.nextSteps?.length).toBeGreaterThan(0);
  });

  it("filters threads by suggested proposals and open commitments", async () => {
    await service.summarizeThread("gmail-thread:alpha");
    await service.extractCommitments("gmail-thread:alpha");

    const queueThreads = await service.listThreads({ hasSuggestedProposal: true });
    expect(queueThreads.map((thread) => thread.id)).toContain("gmail-thread:alpha");

    const commitmentThreads = await service.listThreads({ hasOpenCommitment: true });
    expect(commitmentThreads.map((thread) => thread.id)).toContain("gmail-thread:alpha");
  });

  it("creates a follow-up task when a commitment is accepted and syncs done/dismissed states", async () => {
    const workspaceId = "workspace-follow-up";
    db.prepare(
      `INSERT INTO workspaces
        (id, name, path, created_at, last_used_at, permissions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      "Main Workspace",
      "/tmp/main-workspace",
      now,
      now,
      JSON.stringify({
        read: true,
        write: true,
        delete: false,
        network: true,
        shell: false,
      }),
    );

    const commitmentId = randomUUID();
    db.prepare(
      `INSERT INTO mailbox_commitments
        (id, thread_id, message_id, title, due_at, state, owner_email, source_excerpt, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      commitmentId,
      "gmail-thread:alpha",
      null,
      "Send the revised launch plan",
      now + 24 * 60 * 60 * 1000,
      "suggested",
      "alex@acme.com",
      "Please send the revised launch plan by tomorrow.",
      JSON.stringify({}),
      now,
      now,
    );

    const { TaskRepository } = await import("../../database/repositories");
    const taskRepo = new TaskRepository(db);

    const accepted = await service.updateCommitmentState(commitmentId, "accepted");
    expect(accepted?.state).toBe("accepted");
    expect(accepted?.followUpTaskId).toBeTruthy();

    const acceptedTask = taskRepo.findById(accepted?.followUpTaskId || "");
    expect(acceptedTask?.title).toContain("Follow up:");
    expect(acceptedTask?.workspaceId).toBe(workspaceId);
    expect(acceptedTask?.status).toBe("pending");
    expect(acceptedTask?.dueDate).toBe(now + 24 * 60 * 60 * 1000);

    const done = await service.updateCommitmentState(commitmentId, "done");
    expect(done?.state).toBe("done");
    expect(taskRepo.findById(accepted?.followUpTaskId || "")?.status).toBe("completed");

    const dismissedCommitmentId = randomUUID();
    db.prepare(
      `INSERT INTO mailbox_commitments
        (id, thread_id, message_id, title, due_at, state, owner_email, source_excerpt, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dismissedCommitmentId,
      "gmail-thread:alpha",
      null,
      "Confirm the meeting time",
      null,
      "suggested",
      "alex@acme.com",
      "Please confirm the meeting time.",
      JSON.stringify({}),
      now,
      now,
    );

    const dismissedAccepted = await service.updateCommitmentState(dismissedCommitmentId, "accepted");
    expect(dismissedAccepted?.followUpTaskId).toBeTruthy();
    await service.updateCommitmentState(dismissedCommitmentId, "dismissed");
    expect(taskRepo.findById(dismissedAccepted?.followUpTaskId || "")?.status).toBe("cancelled");
  });

  it("sorts threads by recency or priority when requested", async () => {
    const older = now - 5 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail-thread:beta",
      "gmail:test@example.com",
      "beta",
      "gmail",
      "Priority follow-up",
      "Old but urgent",
      JSON.stringify([{ email: "sam@acme.com", name: "Sam" }]),
      JSON.stringify(["IMPORTANT"]),
      "priority",
      95,
      90,
      1,
      1,
      0,
      0,
      1,
      1,
      older,
      now,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:beta",
      "m-beta-1",
      "outgoing",
      "Test User",
      "test@example.com",
      JSON.stringify([{ email: "sam@acme.com", name: "Sam" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Re: Priority follow-up",
      "Old but urgent",
      "Following up on the item you sent.",
      older,
      0,
      JSON.stringify({}),
      now,
      now,
    );

    const recentThreads = await service.listThreads({ sortBy: "recent" });
    expect(recentThreads[0]?.id).toBe("gmail-thread:alpha");

    const priorityThreads = await service.listThreads({ sortBy: "priority" });
    expect(priorityThreads[0]?.id).toBe("gmail-thread:beta");

    const inboxThreads = await service.listThreads({ mailboxView: "inbox" });
    expect(inboxThreads.map((thread) => thread.id)).not.toContain("gmail-thread:beta");

    const sentThreads = await service.listThreads({ mailboxView: "sent" });
    expect(sentThreads.map((thread) => thread.id)).toContain("gmail-thread:beta");
  });

  it("applies the unread filter when requested", async () => {
    const unreadThreads = await service.listThreads({ unreadOnly: true });
    expect(unreadThreads.every((thread) => thread.unreadCount > 0)).toBe(true);
  });

  it("does not treat onboarding or automated mail as priority follow-up", async () => {
    const normalized = (service as any).normalizeGmailThread(
      "gmail:test@example.com",
      "test@example.com",
      {
        id: "thread-onboarding",
        messages: [
          {
            id: "m-onboarding",
            internalDate: String(now - 3 * 60 * 60 * 1000),
            snippet: "Get started fast and see what's possible.",
            labelIds: [],
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: "Welcome to your Google Cloud Free Trial" },
                { name: "From", value: "Google Cloud <googlecloud-noreply@google.com>" },
                { name: "To", value: "Test User <test@example.com>" },
              ],
              body: {
                data: Buffer.from(
                  "Welcome to Google Cloud. Get started with your free trial credits today. This inbox is not monitored.",
                )
                  .toString("base64")
                  .replace(/\+/g, "-")
                  .replace(/\//g, "_")
                  .replace(/=+$/, ""),
              },
            },
          },
        ],
      },
    );

    expect(normalized.category).toBe("other");
    expect(normalized.needsReply).toBe(false);
    expect(normalized.staleFollowup).toBe(false);
    expect(normalized.priorityScore).toBeLessThan(35);
  });

  it.each([
    {
      threadId: "thread-amazon-revision",
      subject: "Revision to Your Amazon.com Account",
      from: "account-update@amazon.com",
      body: "Thanks for visiting Amazon.com! Per your request, we have updated your mobile phone information. Should you need to contact us for any reason, please know that we can give out order information only to the name and e-mail address associated with your account.",
    },
    {
      threadId: "thread-amazon-passkey",
      subject: "Passkey added to your account",
      from: "account-update@amazon.com",
      body: "Thanks for visiting Amazon! You have successfully added a passkey to your account. If you have questions, please contact us.",
    },
    {
      threadId: "thread-amazon-kdp",
      subject: "Recent update to your Kindle Direct Publishing account",
      from: "kdp-noreply@amazon.com",
      body: "Hello, we are sending this update to let you know your account settings have changed. This inbox is not monitored.",
    },
  ])("does not classify transactional Amazon notifications as reply-needed", async ({ threadId, subject, from, body }) => {
    const normalized = (service as any).normalizeGmailThread(
      "gmail:test@example.com",
      "test@example.com",
      {
        id: threadId,
        messages: [
          {
            id: `${threadId}-message`,
            internalDate: String(now - 2 * 60 * 60 * 1000),
            snippet: body.slice(0, 80),
            labelIds: [],
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: subject },
                { name: "From", value: `Amazon <${from}>` },
                { name: "To", value: "Test User <test@example.com>" },
              ],
              body: {
                data: Buffer.from(body)
                  .toString("base64")
                  .replace(/\+/g, "-")
                  .replace(/\//g, "_")
                  .replace(/=+$/, ""),
              },
            },
          },
        ],
      },
    );

    expect(normalized.needsReply).toBe(false);
    expect(normalized.category).toBe("other");
    expect(normalized.staleFollowup).toBe(false);
  });

  it("persists LLM mailbox classifications and stores their provenance", async () => {
    const factoryModule = await import("../agent/llm/provider-factory");
    const loadSettingsSpy = vi.spyOn(factoryModule.LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o-mini",
      openai: {
        model: "gpt-4o-mini",
        automatedTaskModelKey: "gpt-4o-mini",
        cheapModelKey: "gpt-4o-mini",
      },
    } as never);
    const routingSpy = vi.spyOn(factoryModule.LLMProviderFactory, "getProviderRoutingSettings").mockReturnValue({
      profileRoutingEnabled: true,
      preferStrongForVerification: false,
      strongModelKey: "gpt-4o",
      cheapModelKey: "gpt-4o-mini",
      automatedTaskModelKey: "gpt-4o-mini",
    });
    const resolveSpy = vi.spyOn(factoryModule.LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "openai",
      modelId: "gpt-4o-mini",
      modelKey: "gpt-4o-mini",
      llmProfileUsed: "cheap",
      resolvedModelKey: "gpt-4o-mini",
      modelSource: "profile_model",
      warnings: [],
    });
    const createProviderSpy = vi.spyOn(factoryModule.LLMProviderFactory, "createProvider").mockReturnValue({
      type: "openai",
      createMessage: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              category: "updates",
              needsReply: false,
              priorityScore: 12,
              urgencyScore: 4,
              staleFollowup: false,
              cleanupCandidate: false,
              handled: true,
              confidence: 0.94,
              rationale: "Transactional notice with no reply requested.",
              labels: ["transactional", "account"],
            }),
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 30 },
      }),
    } as never);

    try {
      const result = await service.reclassifyThread("gmail-thread:alpha");
      expect(result.reclassifiedThreads).toBe(1);

      const row = db
        .prepare(
          `SELECT category, needs_reply, priority_score, urgency_score, classification_state,
                  classification_model_key, classification_prompt_version, classification_confidence,
                  classification_fingerprint, classification_json
           FROM mailbox_threads
           WHERE id = ?`,
        )
        .get("gmail-thread:alpha") as {
        category: string;
        needs_reply: number;
        priority_score: number;
        urgency_score: number;
        classification_state: string;
        classification_model_key: string | null;
        classification_prompt_version: string | null;
        classification_confidence: number;
        classification_fingerprint: string | null;
        classification_json: string | null;
      };

      expect(row.category).toBe("updates");
      expect(row.needs_reply).toBe(0);
      expect(row.priority_score).toBe(12);
      expect(row.urgency_score).toBe(4);
      expect(row.classification_state).toBe("classified");
      expect(row.classification_model_key).toBe("gpt-4o-mini");
      expect(row.classification_prompt_version).toBe("v1");
      expect(row.classification_confidence).toBeGreaterThan(0.9);
      expect(row.classification_fingerprint).toBeTruthy();
      expect(row.classification_json).toContain("transactional");
    } finally {
      loadSettingsSpy.mockRestore();
      routingSpy.mockRestore();
      resolveSpy.mockRestore();
      createProviderSpy.mockRestore();
    }
  });

  it("falls back conservatively when the model output is low confidence", async () => {
    const factoryModule = await import("../agent/llm/provider-factory");
    const loadSettingsSpy = vi.spyOn(factoryModule.LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o-mini",
      openai: {
        model: "gpt-4o-mini",
        automatedTaskModelKey: "gpt-4o-mini",
        cheapModelKey: "gpt-4o-mini",
      },
    } as never);
    vi.spyOn(factoryModule.LLMProviderFactory, "getProviderRoutingSettings").mockReturnValue({
      profileRoutingEnabled: true,
      preferStrongForVerification: false,
      strongModelKey: "gpt-4o",
      cheapModelKey: "gpt-4o-mini",
      automatedTaskModelKey: "gpt-4o-mini",
    });
    vi.spyOn(factoryModule.LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "openai",
      modelId: "gpt-4o-mini",
      modelKey: "gpt-4o-mini",
      llmProfileUsed: "cheap",
      resolvedModelKey: "gpt-4o-mini",
      modelSource: "profile_model",
      warnings: [],
    });
    vi.spyOn(factoryModule.LLMProviderFactory, "createProvider").mockReturnValue({
      type: "openai",
      createMessage: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              category: "priority",
              needsReply: true,
              priorityScore: 97,
              urgencyScore: 91,
              staleFollowup: true,
              cleanupCandidate: false,
              handled: false,
              confidence: 0.12,
              rationale: "Not sure, maybe needs a reply?",
              labels: ["uncertain"],
            }),
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 30 },
      }),
    } as never);

    try {
      await service.reclassifyThread("gmail-thread:alpha");

      const row = db
        .prepare(
          `SELECT category, needs_reply, priority_score, urgency_score, classification_confidence
           FROM mailbox_threads
           WHERE id = ?`,
        )
        .get("gmail-thread:alpha") as {
        category: string;
        needs_reply: number;
        priority_score: number;
        urgency_score: number;
        classification_confidence: number;
      };

      expect(row.category).toBe("other");
      expect(row.needs_reply).toBe(0);
      expect(row.priority_score).toBeLessThan(20);
      expect(row.urgency_score).toBeLessThan(20);
      expect(row.classification_confidence).toBeLessThan(0.2);
    } finally {
      loadSettingsSpy.mockRestore();
    }
  });
});

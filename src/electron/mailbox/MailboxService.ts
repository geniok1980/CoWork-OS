import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";
import { ChannelRepository, TaskRepository, WorkspaceRepository } from "../database/repositories";
import { LLMProviderFactory } from "../agent/llm/provider-factory";
import type { LLMMessage } from "../agent/llm/types";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";
import { gmailRequest } from "../utils/gmail-api";
import { googleCalendarRequest } from "../utils/google-calendar-api";
import { EmailClient } from "../gateway/channels/email-client";
import { LoomEmailClient } from "../gateway/channels/loom-client";
import { assertSafeLoomMailboxFolder } from "../utils/loom";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import type {
  MailboxAccount,
  MailboxActionProposal,
  MailboxApplyActionInput,
  MailboxBulkReviewInput,
  MailboxBulkReviewResult,
  MailboxCommitment,
  MailboxCommitmentState,
  MailboxContactMemory,
  MailboxDraftOptions,
  MailboxDraftSuggestion,
  MailboxListThreadsInput,
  MailboxMessage,
  MailboxParticipant,
  MailboxPriorityBand,
  MailboxClassificationState,
  MailboxProposalStatus,
  MailboxProposalType,
  MailboxProvider,
  MailboxResearchResult,
  MailboxReclassifyInput,
  MailboxReclassifyResult,
  MailboxSummaryCard,
  MailboxSyncResult,
  MailboxSyncStatus,
  MailboxSyncProgress,
  MailboxThreadCategory,
  MailboxThreadDetail,
  MailboxThreadListItem,
  MailboxThreadSortOrder,
  MailboxThreadMailboxView,
} from "../../shared/mailbox";
import type { Task } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";

type MailboxAccountRow = {
  id: string;
  provider: MailboxProvider;
  address: string;
  display_name: string | null;
  status: "connected" | "degraded" | "disconnected";
  capabilities_json: string | null;
  last_synced_at: number | null;
  classification_initial_batch_at: number | null;
};

type MailboxThreadRow = {
  id: string;
  account_id: string;
  provider: MailboxProvider;
  provider_thread_id: string;
  subject: string;
  snippet: string;
  participants_json: string | null;
  labels_json: string | null;
  category: MailboxThreadCategory;
  priority_score: number;
  urgency_score: number;
  needs_reply: number;
  stale_followup: number;
  cleanup_candidate: number;
  handled: number;
  unread_count: number;
  message_count: number;
  last_message_at: number;
  classification_state: MailboxClassificationState;
  classification_fingerprint: string | null;
  classification_model_key: string | null;
  classification_prompt_version: string | null;
  classification_confidence: number;
  classification_updated_at: number | null;
  classification_error: string | null;
};

type MailboxMessageRow = {
  id: string;
  thread_id: string;
  provider_message_id: string;
  direction: "incoming" | "outgoing";
  from_name: string | null;
  from_email: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  subject: string;
  snippet: string;
  body_text: string;
  body_html: string | null;
  received_at: number;
  is_unread: number;
};

type MailboxSummaryRow = {
  thread_id: string;
  summary_text: string;
  key_asks_json: string | null;
  extracted_questions_json: string | null;
  suggested_next_action: string;
  confidence: number;
  updated_at: number;
};

type ThreadUpsertResult = {
  shouldClassify: boolean;
  isNewThread: boolean;
};

type MailboxDraftRow = {
  id: string;
  thread_id: string;
  subject: string;
  body_text: string;
  tone: string;
  rationale: string;
  schedule_notes: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxProposalRow = {
  id: string;
  thread_id: string;
  proposal_type: MailboxProposalType;
  title: string;
  reasoning: string;
  preview_json: string | null;
  status: MailboxProposalStatus;
  created_at: number;
  updated_at: number;
};

type MailboxCommitmentRow = {
  id: string;
  thread_id: string;
  message_id: string | null;
  title: string;
  due_at: number | null;
  state: MailboxCommitmentState;
  owner_email: string | null;
  source_excerpt: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxCommitmentMetadata = {
  source?: string;
  followUpTaskId?: string;
  followUpTaskCreatedAt?: number;
  followUpTaskWorkspaceId?: string;
};

type MailboxContactRow = {
  id: string;
  account_id: string;
  email: string;
  name: string | null;
  company: string | null;
  role: string | null;
  crm_links_json: string | null;
  learned_facts_json: string | null;
  response_tendency: string | null;
  last_interaction_at: number | null;
  open_commitments: number;
};

type ScheduleOption = {
  label: string;
  start: string;
  end: string;
};

type ScheduleSuggestion = {
  options: ScheduleOption[];
  summary: string;
};

type MailboxClassificationResult = {
  category: MailboxThreadCategory;
  needsReply: boolean;
  priorityScore: number;
  urgencyScore: number;
  staleFollowup: boolean;
  cleanupCandidate: boolean;
  handled: boolean;
  confidence: number;
  rationale?: string;
  labels?: string[];
};

type MailboxClassificationSnapshot = {
  threadId: string;
  accountId: string;
  provider: MailboxProvider;
  subject: string;
  snippet: string;
  unreadCount: number;
  categoryHint?: MailboxThreadCategory;
  participants: MailboxParticipant[];
  labels: string[];
  lastMessageAt: number;
  messageCount: number;
  messages: Array<{
    direction: "incoming" | "outgoing";
    from?: MailboxParticipant;
    snippet: string;
    body: string;
    receivedAt: number;
    unread: boolean;
  }>;
};

type DraftStyleProfile = {
  greeting?: string;
  signoff?: string;
  tone: MailboxDraftOptions["tone"];
  averageLength: number;
  averageResponseHours?: number;
  styleSignals: string[];
  recentOutboundExample?: string;
};

type NormalizedThreadInput = {
  id: string;
  accountId: string;
  provider: MailboxProvider;
  providerThreadId: string;
  subject: string;
  snippet: string;
  participants: MailboxParticipant[];
  labels: string[];
  category: MailboxThreadCategory;
  priorityScore: number;
  urgencyScore: number;
  needsReply: boolean;
  staleFollowup: boolean;
  cleanupCandidate: boolean;
  handled: boolean;
  unreadCount: number;
  lastMessageAt: number;
  messages: Array<{
    id: string;
    providerMessageId: string;
    direction: "incoming" | "outgoing";
    from?: MailboxParticipant;
    to: MailboxParticipant[];
    cc: MailboxParticipant[];
    bcc: MailboxParticipant[];
    subject: string;
    snippet: string;
    body: string;
    bodyHtml?: string;
    receivedAt: number;
    unread: boolean;
  }>;
};

type NormalizedMailboxMessage = NormalizedThreadInput["messages"][number];

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseCommitmentMetadata(value: string | null | undefined): MailboxCommitmentMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    return {
      source: asString(record.source) || undefined,
      followUpTaskId: asString(record.followUpTaskId) || undefined,
      followUpTaskCreatedAt: asNumber(record.followUpTaskCreatedAt) || undefined,
      followUpTaskWorkspaceId: asString(record.followUpTaskWorkspaceId) || undefined,
    };
  } catch {
    return {};
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeWhitespace(value: string, maxLength = 600): string {
  const text = String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeEmailAddress(value?: string | null): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] || raw).trim().toLowerCase();
}

function formatScheduleLabel(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildScheduleOption(date: Date, durationMinutes = 30): ScheduleOption {
  const end = new Date(date.getTime() + durationMinutes * 60 * 1000);
  return {
    label: formatScheduleLabel(date),
    start: date.toISOString(),
    end: end.toISOString(),
  };
}

function average(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function inferGreeting(messages: string[]): string | undefined {
  for (const text of messages) {
    const firstLine = excerptLines(text, 1)[0];
    if (/^(hi|hello|hey)\b/i.test(firstLine || "")) {
      return normalizeWhitespace(firstLine || "", 40);
    }
  }
  return undefined;
}

function inferSignoff(messages: string[]): string | undefined {
  for (const text of [...messages].reverse()) {
    const lines = String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^(best|thanks|thank you|regards|cheers)[,!]?$/i.test(lines[index] || "")) {
        return lines[index];
      }
    }
  }
  return undefined;
}

function classifyTone(messages: string[]): DraftStyleProfile["tone"] {
  const combined = messages.join("\n");
  const averageChars = average(messages.map((message) => message.length)) || 0;
  if (/\bappreciate|thanks so much|glad|happy to\b/i.test(combined)) return "warm";
  if (/\bplease|kindly|attached|review|next steps|timeline\b/i.test(combined)) return "executive";
  if (averageChars < 180 || /\bquick update\b/i.test(combined)) return "concise";
  return "direct";
}

function extractDisplayName(value?: string | null): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const match = raw.match(/^(.*?)\s*<[^>]+>$/);
  const name = (match?.[1] || "").replace(/^"|"$/g, "").trim();
  return name || undefined;
}

function parseAddressList(input: unknown): MailboxParticipant[] {
  if (Array.isArray(input)) {
    return input.flatMap((entry) => parseAddressList(entry));
  }

  const raw = asString(input);
  if (!raw) return [];

  return raw
    .split(",")
    .map((part) => {
      const email = normalizeEmailAddress(part);
      if (!email) return null;
      return {
        email,
        name: extractDisplayName(part),
      } as MailboxParticipant;
    })
    .filter((entry): entry is MailboxParticipant => Boolean(entry));
}

function base64UrlDecode(data?: string): string {
  if (!data) return "";
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function extractGmailHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  const header = headers.find((entry) => entry?.name?.toLowerCase() === lower);
  return header?.value || null;
}

function extractGmailBody(payload: Any): string {
  const mimeType = asString(payload?.mimeType) || "";

  if (payload?.body?.data) {
    if (mimeType === "text/html") {
      return normalizeWhitespace(stripHtml(base64UrlDecode(payload.body.data)), 4000);
    }
    // text/plain or unknown — decode as-is
    return normalizeWhitespace(base64UrlDecode(payload.body.data), 4000);
  }

  const parts = Array.isArray(payload?.parts) ? payload.parts : [];
  if (parts.length === 0) return "";

  // For multipart/alternative prefer the HTML part (richer content, cleaner after
  // stripping) — RFC 2822 orders plain first and html last, so iterate in reverse.
  const orderedParts =
    mimeType === "multipart/alternative" ? [...parts].reverse() : parts;

  for (const part of orderedParts) {
    const text = extractGmailBody(part);
    if (text) return text;
  }

  return "";
}

/** Extract raw HTML body from a Gmail message payload for rendering in the UI. */
function extractGmailHtml(payload: Any): string {
  const mimeType = asString(payload?.mimeType) || "";

  if (payload?.body?.data && mimeType === "text/html") {
    return base64UrlDecode(payload.body.data);
  }

  const parts = Array.isArray(payload?.parts) ? payload.parts : [];
  for (const part of parts) {
    const html = extractGmailHtml(part);
    if (html) return html;
  }

  return "";
}

function uniqueParticipants(participants: MailboxParticipant[]): MailboxParticipant[] {
  const byEmail = new Map<string, MailboxParticipant>();
  for (const participant of participants) {
    const email = normalizeEmailAddress(participant.email);
    if (!email) continue;
    const current = byEmail.get(email);
    if (!current || (!current.name && participant.name)) {
      byEmail.set(email, { email, name: participant.name });
    }
  }
  return Array.from(byEmail.values());
}

function normalizeClassifierText(subject: string, body: string): string {
  return `${subject} ${body}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function isAutomatedMailbox(subject: string, body: string, senderEmail?: string, labels: string[] = []): boolean {
  const text = normalizeClassifierText(subject, body);
  const labelSet = new Set(labels.map((label) => label.toUpperCase()));
  const sender = String(senderEmail || "").toLowerCase();
  return (
    labelSet.has("CATEGORY_UPDATES") ||
    /\b(no-?reply|noreply|do not reply|this inbox is not monitored|automated|system generated|unmonitored)\b/.test(
      `${text} ${sender}`,
    ) ||
    /\b(verification code|password reset|2-step verification|2fa|security alert|security code|privacy settings|verify your identity|password has been changed|sign-?in|login|one-time code|otp|account data access attempt)\b/.test(
      text,
    ) ||
    /\b(receipt|invoice|statement|billing|order update|order confirmation|shipment|delivery|tracking|return|refund|trial ending|free trial|new google account|passkey added|your account has been|your account was|recent update to your|revision to your|updated your mobile phone information|identity was successfully verified)\b/.test(
      text,
    )
  );
}

function isOnboardingMailbox(subject: string, body: string): boolean {
  const text = normalizeClassifierText(subject, body);
  return /\b(welcome to|get started|setup guide|onboarding|free trial|trial credits|information about your new)\b/.test(
    text,
  );
}

function hasDirectReplyRequest(text: string): boolean {
  return (
    /\b(can you|could you|would you|would you mind|do you mind|are you able to|can we|when can you|what time works|does that work|let me know if you|please let me know|please confirm|please review|please respond|please reply|please share|please provide|please send|please update|please schedule|please check|please take a look|i need you to|we need you to|i'd like you to|we'd like you to)\b/.test(
      text,
    ) ||
    /\b(?:can|could|would|will|are|is|do|does|did|what|when|where|why|how)\b[^?.!]{0,80}\?/i.test(text)
  );
}

function hasBoilerplateNotification(text: string): boolean {
  return (
    /\b(should you need to contact us|if you have any questions|if you have questions|if you need anything|please know that|you can always|contact us|thanks for shopping with us|thanks for visiting|per your request|we have successfully|we have updated|we have changed|we have enabled|your account has been|your account was|this inbox is not monitored|this is an automated message)\b/.test(
      text,
    ) || /\b(should you need|if you need to|for your reference|just letting you know)\b/.test(text)
  );
}

function likelyNeedsReply(params: {
  direction: "incoming" | "outgoing";
  subject: string;
  body: string;
  senderEmail?: string;
  labels?: string[];
  category?: MailboxThreadCategory;
}): boolean {
  if (params.direction !== "incoming") return false;
  const labels = params.labels || [];
  const text = normalizeClassifierText(params.subject, params.body);
  if (
    isAutomatedMailbox(params.subject, params.body, params.senderEmail, labels) ||
    isOnboardingMailbox(params.subject, params.body) ||
    params.category === "promotions" ||
    params.category === "updates"
  ) {
    return false;
  }
  if (hasBoilerplateNotification(text)) return false;
  return hasDirectReplyRequest(text);
}

function deriveCategory(
  subject: string,
  labels: string[],
  body: string,
  senderEmail?: string,
): MailboxThreadCategory {
  const lowerSubject = subject.toLowerCase();
  const lowerBody = body.toLowerCase();
  const text = normalizeClassifierText(subject, body);
  const labelSet = new Set(labels.map((label) => label.toUpperCase()));

  if (
    labelSet.has("CATEGORY_PROMOTIONS") ||
    /\bnewsletter|sale|discount|unsubscribe|free trial|upgrade offer|limited time\b/.test(lowerBody)
  ) {
    return "promotions";
  }
  if (
    isAutomatedMailbox(subject, body, senderEmail, labels) ||
    isOnboardingMailbox(subject, body) ||
    /\breceipt|invoice|notification|alert|verification|password|security|privacy|passkey|account update|account revision|account confirmation|identity verified\b/.test(text)
  ) {
    return "updates";
  }
  if (/\bmeet|schedule|calendar|availability|slot\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "calendar";
  }
  if (/\bfollow up|checking in|circling back|nudge\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "follow_up";
  }
  if (labelSet.has("IMPORTANT") || /\burgent|asap|deadline|today|blocking\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "priority";
  }
  if (/\b(family|friend|friends|personal|birthday|wedding|party|vacation|holiday|catch up|coffee|lunch|dinner|weekend|invitation|invite|rsvp|congratulations|condolences)\b/.test(text)) {
    return "personal";
  }
  return "other";
}

function computeScores(params: {
  subject: string;
  body: string;
  unreadCount: number;
  lastMessageAt: number;
  needsReply: boolean;
  cleanupCandidate: boolean;
  category: MailboxThreadCategory;
}): { priorityScore: number; urgencyScore: number; staleFollowup: boolean; handled: boolean } {
  const text = `${params.subject} ${params.body}`.toLowerCase();
  let priorityScore = 20;
  let urgencyScore = 10;

  if (params.unreadCount > 0) {
    priorityScore += 18;
    urgencyScore += 8;
  }
  if (params.needsReply) {
    priorityScore += 14;
    urgencyScore += 12;
  }
  if (/\burgent|asap|critical|today|deadline|immediately|eod\b/.test(text)) {
    priorityScore += 22;
    urgencyScore += 24;
  }
  if (params.category === "priority") {
    priorityScore += 16;
    urgencyScore += 12;
  }
  if (params.category === "calendar") {
    priorityScore += 10;
    urgencyScore += 18;
  }
  if (params.category === "updates") {
    priorityScore -= 8;
    urgencyScore -= 6;
  }
  if (params.category === "promotions") {
    priorityScore -= 16;
    urgencyScore -= 10;
  }
  if (params.cleanupCandidate) {
    priorityScore -= 10;
    urgencyScore -= 8;
  }

  const ageHours = Math.max(0, Date.now() - params.lastMessageAt) / (60 * 60 * 1000);
  const staleFollowup = params.needsReply && ageHours >= 36;
  if (staleFollowup) {
    urgencyScore += 18;
  }

  priorityScore = Math.max(0, Math.min(100, priorityScore));
  urgencyScore = Math.max(0, Math.min(100, urgencyScore));
  return {
    priorityScore,
    urgencyScore,
    staleFollowup,
    handled: !params.needsReply && params.unreadCount === 0,
  };
}

function priorityBandFromScore(score: number): MailboxPriorityBand {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  return "low";
}

const MAILBOX_CLASSIFIER_PROMPT_VERSION = "v2";
const MAILBOX_CLASSIFIER_MAX_BATCH = 50;
const MAILBOX_CLASSIFIER_MAX_MESSAGES = 6;
const MAILBOX_CLASSIFIER_MAX_TOKENS = 1400;
const MAILBOX_CLASSIFIER_MIN_CONFIDENCE = 0.45;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function mailboxClassificationFingerprint(snapshot: MailboxClassificationSnapshot): string {
  const payload = {
    threadId: snapshot.threadId,
    accountId: snapshot.accountId,
    provider: snapshot.provider,
    subject: normalizeWhitespace(snapshot.subject, 200),
    snippet: normalizeWhitespace(snapshot.snippet, 200),
    unreadCount: snapshot.unreadCount,
    categoryHint: snapshot.categoryHint || null,
    participants: snapshot.participants
      .map((participant) => ({
        email: participant.email.toLowerCase(),
        name: participant.name || "",
      }))
      .sort((a, b) => a.email.localeCompare(b.email)),
    labels: [...snapshot.labels].map((label) => label.toUpperCase()).sort(),
    lastMessageAt: snapshot.lastMessageAt,
    messages: snapshot.messages.map((message) => ({
      direction: message.direction,
      from: message.from?.email?.toLowerCase() || "",
      unread: message.unread,
      receivedAt: message.receivedAt,
      snippet: normalizeWhitespace(message.snippet, 240),
      body: normalizeWhitespace(message.body, 600),
    })),
  };
  return sha256(JSON.stringify(payload));
}

function summarizeMailboxBody(body: string): string {
  return normalizeWhitespace(body, 1000);
}

function mailboxClassificationFallback(
  snapshot: MailboxClassificationSnapshot,
): MailboxClassificationResult {
  return {
    category: "other",
    needsReply: false,
    priorityScore: clampScore(snapshot.unreadCount > 0 ? 25 : 5),
    urgencyScore: clampScore(snapshot.unreadCount > 0 ? 10 : 0),
    staleFollowup: false,
    cleanupCandidate: false,
    handled: snapshot.unreadCount === 0,
    confidence: 0.15,
    rationale: "Conservative fallback used because no LLM classification was available.",
  };
}

function companyFromEmail(email?: string): string | undefined {
  const normalized = normalizeEmailAddress(email || "");
  if (!normalized || normalized.endsWith("@gmail.com") || normalized.endsWith("@outlook.com")) {
    return undefined;
  }
  const domain = normalized.split("@")[1] || "";
  const label = domain.split(".")[0] || "";
  if (!label) return undefined;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function excerptLines(text: string, count = 2): string[] {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, count);
}

function parseDueAt(text: string): number | undefined {
  const normalized = text.toLowerCase();
  if (/\btoday\b/.test(normalized)) {
    return Date.now() + 10 * 60 * 60 * 1000;
  }
  if (/\btomorrow\b/.test(normalized)) {
    return Date.now() + 34 * 60 * 60 * 1000;
  }
  const weekdayMatch = normalized.match(
    /\b(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?)\b/,
  );
  if (weekdayMatch) {
    const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const target = weekdays.findIndex((entry) => weekdayMatch[1].startsWith(entry));
    if (target >= 0) {
      const now = new Date();
      const result = new Date(now);
      let diff = target - now.getDay();
      if (diff <= 0) diff += 7;
      result.setDate(now.getDate() + diff);
      result.setHours(16, 0, 0, 0);
      return result.getTime();
    }
  }
  return undefined;
}

export class MailboxService {
  private channelRepo: ChannelRepository;
  private taskRepo: TaskRepository;
  private workspaceRepo: WorkspaceRepository;
  private syncInFlight = false;
  private syncProgress: MailboxSyncProgress | null = null;

  constructor(private db: Database.Database) {
    this.channelRepo = new ChannelRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
  }

  isAvailable(): boolean {
    return GoogleWorkspaceSettingsManager.loadSettings().enabled || this.hasEmailChannel();
  }

  private isLoomEmailChannel(): boolean {
    const channel = this.channelRepo.findByType("email");
    const cfg = (channel?.config as Any) || {};
    return Boolean(channel?.enabled && asString(cfg.protocol) === "loom");
  }

  async getSyncStatus(): Promise<MailboxSyncStatus> {
    const accountRows = this.db
      .prepare(
        `SELECT id, provider, address, display_name, status, capabilities_json, classification_initial_batch_at, last_synced_at
         FROM mailbox_accounts
         ORDER BY updated_at DESC`,
      )
      .all() as MailboxAccountRow[];

    const accounts = accountRows.map((row) => this.mapAccountRow(row));
    const countsRow = this.db
      .prepare(
        `SELECT
           COUNT(*) AS thread_count,
           COALESCE(SUM(unread_count), 0) AS unread_count,
           COALESCE(SUM(CASE WHEN needs_reply = 1 THEN 1 ELSE 0 END), 0) AS needs_reply_count,
           COALESCE(
             SUM(CASE WHEN classification_state IN ('pending', 'backfill_pending') THEN 1 ELSE 0 END),
             0
           ) AS classification_pending_count
         FROM mailbox_threads`,
      )
      .get() as {
      thread_count: number;
      unread_count: number;
      needs_reply_count: number;
      classification_pending_count: number;
    };
    const proposalCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_action_proposals
         WHERE status = 'suggested'`,
      )
      .get() as { count: number };
    const commitmentCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_commitments
         WHERE state IN ('suggested', 'accepted')`,
      )
      .get() as { count: number };

    const lastSyncedAt =
      accounts
        .map((account) => account.lastSyncedAt || 0)
        .sort((a, b) => b - a)[0] || undefined;
    const primaryProvider = accounts[0]?.provider;

    return {
      connected: accounts.length > 0,
      primaryProvider,
      accounts,
      lastSyncedAt,
      syncInFlight: this.syncInFlight,
      syncProgress: this.syncProgress,
      threadCount: countsRow.thread_count || 0,
      unreadCount: countsRow.unread_count || 0,
      needsReplyCount: countsRow.needs_reply_count || 0,
      proposalCount: proposalCountRow.count || 0,
      commitmentCount: commitmentCountRow.count || 0,
      classificationPendingCount: countsRow.classification_pending_count || 0,
      statusLabel:
        accounts.length === 0
          ? "Connect Gmail or Email channel"
          : `${accounts.length} account${accounts.length === 1 ? "" : "s"} synced${
              this.syncInFlight && this.syncProgress?.label
                ? ` · ${this.syncProgress.label}`
                : countsRow.classification_pending_count
                  ? ` · ${countsRow.classification_pending_count} awaiting AI classification`
                  : ""
            }`,
    };
  }

  private updateSyncProgress(progress: Omit<MailboxSyncProgress, "updatedAt">): void {
    this.syncProgress = {
      ...progress,
      updatedAt: Date.now(),
    };
  }

  async sync(limit = 25): Promise<MailboxSyncResult> {
    this.syncInFlight = true;
    this.updateSyncProgress({
      phase: "fetching",
      totalThreads: 0,
      processedThreads: 0,
      totalMessages: 0,
      processedMessages: 0,
      newThreads: 0,
      classifiedThreads: 0,
      skippedThreads: 0,
      label: "Starting mailbox sync...",
    });
    try {
      const accounts: MailboxAccount[] = [];
      let syncedThreads = 0;
      let syncedMessages = 0;

      if (GoogleWorkspaceSettingsManager.loadSettings().enabled) {
        const result = await this.syncGmail(limit);
        if (result) {
          accounts.push(result.account);
          syncedThreads += result.syncedThreads;
          syncedMessages += result.syncedMessages;
        }
      }

      if (accounts.length === 0 && this.hasEmailChannel()) {
        const result = await this.syncImap(limit);
        if (result) {
          accounts.push(result.account);
          syncedThreads += result.syncedThreads;
          syncedMessages += result.syncedMessages;
        }
      }

      if (accounts.length === 0) {
        throw new Error(
          "No connected mailbox was found. Enable Google Workspace or configure the Email channel.",
        );
      }

      const lastSyncedAt = Date.now();
      this.updateSyncProgress({
        phase: "done",
        totalThreads: syncedThreads,
        processedThreads: syncedThreads,
        totalMessages: syncedMessages,
        processedMessages: syncedMessages,
        newThreads: syncedThreads,
        classifiedThreads: 0,
        skippedThreads: 0,
        label:
          syncedThreads > 0
            ? `Synced ${syncedThreads} thread${syncedThreads === 1 ? "" : "s"} and ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}`
            : "Mailbox sync complete",
      });
      return {
        accounts,
        syncedThreads,
        syncedMessages,
        lastSyncedAt,
      };
    } catch (error) {
      this.updateSyncProgress({
        phase: "error",
        totalThreads: 0,
        processedThreads: 0,
        totalMessages: 0,
        processedMessages: 0,
        newThreads: 0,
        classifiedThreads: 0,
        skippedThreads: 0,
        label: `Mailbox sync failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    } finally {
      this.syncInFlight = false;
    }
  }

  async reclassifyThread(threadId: string): Promise<MailboxReclassifyResult> {
    const thread = this.db
      .prepare("SELECT account_id FROM mailbox_threads WHERE id = ?")
      .get(threadId) as { account_id: string } | undefined;
    if (!thread) {
      throw new Error("Thread not found");
    }
    const updated = await this.classifyThreadById(threadId, { force: true });
    return {
      accountId: thread.account_id,
      scannedThreads: 1,
      reclassifiedThreads: updated ? 1 : 0,
    };
  }

  async reclassifyAccount(input: MailboxReclassifyInput): Promise<MailboxReclassifyResult> {
    const accountId = input.accountId?.trim();
    if (!accountId) {
      throw new Error("Missing accountId for mailbox reclassification");
    }

    if (input.scope === "thread") {
      if (!input.threadId) {
        throw new Error("Missing threadId for mailbox thread reclassification");
      }
      return this.reclassifyThread(input.threadId);
    }

    const includeBackfill = input.scope === "backfill" || input.scope === "account";
    const force = input.scope === "account";
    const result = await this.classifyMailboxThreadsForAccount(accountId, {
      includeBackfill,
      limit: input.limit || MAILBOX_CLASSIFIER_MAX_BATCH,
      force,
    });

    if (force) {
      this.db
        .prepare(
          `UPDATE mailbox_accounts
           SET classification_initial_batch_at = COALESCE(classification_initial_batch_at, ?),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), Date.now(), accountId);
    }

    return result;
  }

  async listThreads(input: MailboxListThreadsInput = {}): Promise<MailboxThreadListItem[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (input.query) {
      conditions.push(`(
        subject LIKE ?
        OR snippet LIKE ?
        OR participants_json LIKE ?
        OR EXISTS (
          SELECT 1
          FROM mailbox_messages mm
          WHERE mm.thread_id = mailbox_threads.id
            AND (
              mm.subject LIKE ?
              OR mm.snippet LIKE ?
              OR mm.body_text LIKE ?
              OR COALESCE(mm.from_name, '') LIKE ?
              OR COALESCE(mm.from_email, '') LIKE ?
              OR COALESCE(mm.to_json, '') LIKE ?
              OR COALESCE(mm.cc_json, '') LIKE ?
            )
        )
      )`);
      const like = `%${input.query}%`;
      values.push(like, like, like, like, like, like, like, like, like, like);
    }
    if (input.category && input.category !== "all") {
      conditions.push("category = ?");
      values.push(input.category);
    }
    const mailboxView: MailboxThreadMailboxView = input.mailboxView || "inbox";
    if (mailboxView === "inbox") {
      conditions.push(
        `EXISTS (
          SELECT 1
          FROM mailbox_messages m
          WHERE m.thread_id = mailbox_threads.id
            AND m.direction = 'incoming'
        )`,
      );
    } else if (mailboxView === "sent") {
      conditions.push(
        `NOT EXISTS (
          SELECT 1
          FROM mailbox_messages m
          WHERE m.thread_id = mailbox_threads.id
            AND m.direction = 'incoming'
        )`,
      );
    }
    if (typeof input.unreadOnly === "boolean") {
      conditions.push(input.unreadOnly ? "unread_count > 0" : "unread_count = 0");
    }
    if (typeof input.needsReply === "boolean") {
      conditions.push("needs_reply = ?");
      values.push(input.needsReply ? 1 : 0);
    }
    if (typeof input.hasSuggestedProposal === "boolean") {
      conditions.push(
        input.hasSuggestedProposal
          ? `EXISTS (
              SELECT 1
              FROM mailbox_action_proposals map
              WHERE map.thread_id = mailbox_threads.id
                AND map.status = 'suggested'
            )`
          : `NOT EXISTS (
              SELECT 1
              FROM mailbox_action_proposals map
              WHERE map.thread_id = mailbox_threads.id
                AND map.status = 'suggested'
            )`,
      );
    }
    if (typeof input.hasOpenCommitment === "boolean") {
      conditions.push(
        input.hasOpenCommitment
          ? `EXISTS (
              SELECT 1
              FROM mailbox_commitments mc
              WHERE mc.thread_id = mailbox_threads.id
                AND mc.state IN ('suggested', 'accepted')
            )`
          : `NOT EXISTS (
              SELECT 1
              FROM mailbox_commitments mc
              WHERE mc.thread_id = mailbox_threads.id
                AND mc.state IN ('suggested', 'accepted')
            )`,
      );
    }
    if (typeof input.cleanupCandidate === "boolean") {
      conditions.push("cleanup_candidate = ?");
      values.push(input.cleanupCandidate ? 1 : 0);
    }

    const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);
    const sortBy: MailboxThreadSortOrder = input.sortBy === "recent" ? "recent" : "priority";
    const orderBy =
      sortBy === "recent"
        ? "last_message_at DESC, priority_score DESC, urgency_score DESC"
        : "priority_score DESC, urgency_score DESC, last_message_at DESC";
    const rows = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           unread_count,
           message_count,
           last_message_at,
           classification_state
         FROM mailbox_threads
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY ${orderBy}
         LIMIT ?`,
      )
      .all(...values, limit) as MailboxThreadRow[];

    return rows.map((row) => this.mapThreadRow(row, this.getSummaryForThread(row.id) ?? undefined));
  }

  async getThread(threadId: string): Promise<MailboxThreadDetail | null> {
    const row = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           unread_count,
           message_count,
           last_message_at,
           classification_state
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(threadId) as MailboxThreadRow | undefined;
    if (!row) return null;

    const summary = this.getSummaryForThread(threadId) ?? (await this.summarizeThread(threadId));
    const messages = this.getMessagesForThread(threadId);
    const drafts = this.getDraftsForThread(threadId);
    const proposals = this.getProposalsForThread(threadId);
    const commitments = this.getCommitmentsForThread(threadId);
    const contactMemory = this.getPrimaryContactMemory(threadId);
    const research = await this.researchContact(threadId);

    return {
      ...this.mapThreadRow(row, summary || undefined),
      messages,
      drafts,
      proposals,
      commitments,
      contactMemory,
      research,
    };
  }

  async summarizeThread(threadId: string): Promise<MailboxSummaryCard | null> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return null;

    const combinedText = detail.messages
      .map((message) => message.body || message.snippet)
      .join("\n\n")
      .trim();
    const lines = excerptLines(combinedText, 4);
    const questions = detail.messages
      .flatMap((message) =>
        excerptLines(message.body, 6).filter((line) => line.includes("?")),
      )
      .slice(0, 3);
    const asks = detail.messages
      .flatMap((message) =>
        excerptLines(message.body, 6).filter((line) =>
          /\bplease|can you|could you|need|action|required|review\b/i.test(line),
        ),
      )
      .slice(0, 3);

    const summaryText =
      lines[0] ||
      detail.snippet ||
      `Recent email activity in ${detail.subject || "this thread"}`;
    const nextAction = detail.needsReply
      ? "Draft a reply"
      : detail.cleanupCandidate
        ? "Queue for cleanup review"
        : detail.category === "calendar"
          ? "Propose scheduling options"
          : "Keep as reference";
    const confidence = Math.min(
      0.94,
      0.58 + (asks.length > 0 ? 0.16 : 0) + (questions.length > 0 ? 0.12 : 0),
    );
    const updatedAt = Date.now();

    this.db
      .prepare(
        `INSERT INTO mailbox_summaries
          (thread_id, summary_text, key_asks_json, extracted_questions_json, suggested_next_action, confidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           summary_text = excluded.summary_text,
           key_asks_json = excluded.key_asks_json,
           extracted_questions_json = excluded.extracted_questions_json,
           suggested_next_action = excluded.suggested_next_action,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      )
      .run(
        threadId,
        normalizeWhitespace(summaryText, 340),
        JSON.stringify(asks),
        JSON.stringify(questions),
        nextAction,
        confidence,
        updatedAt,
      );

    this.refreshThreadProposals(detail);

    return {
      summary: normalizeWhitespace(summaryText, 340),
      keyAsks: asks,
      extractedQuestions: questions,
      suggestedNextAction: nextAction,
      confidence,
      updatedAt,
    };
  }

  async generateDraft(
    threadId: string,
    options: MailboxDraftOptions = {},
  ): Promise<MailboxDraftSuggestion | null> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return null;

    const summary = this.getSummaryForThread(threadId) || (await this.summarizeThread(threadId));
    const scheduleSuggestion =
      options.includeAvailability !== false && detail.category === "calendar"
        ? await this.getScheduleSuggestion()
        : null;
    const relationshipContext = RelationshipMemoryService.buildPromptContext({
      maxPerLayer: 1,
      maxChars: 420,
    });
    const latestIncoming =
      detail.messages.filter((message) => message.direction === "incoming").slice(-1)[0] ||
      detail.messages[detail.messages.length - 1];
    const recipient =
      latestIncoming?.from?.name || latestIncoming?.from?.email || detail.participants[0]?.email || "there";
    const contactEmail = detail.participants[0]?.email;
    const styleProfile = this.buildDraftStyleProfile({
      outgoingMessages: contactEmail
        ? this.db
            .prepare(
              `SELECT m.body_text
               FROM mailbox_messages m
               JOIN mailbox_threads t ON t.id = m.thread_id
               WHERE t.account_id = ? AND t.participants_json LIKE ? AND m.direction = 'outgoing'
               ORDER BY m.received_at ASC`,
            )
            .all(detail.accountId, `%${contactEmail}%`)
            .map((row) => normalizeWhitespace((row as { body_text: string }).body_text, 600))
        : [],
      averageResponseHours: contactEmail ? this.getPrimaryContactMemory(threadId)?.averageResponseHours : undefined,
    });
    const greetingPrefix = styleProfile.greeting?.match(/^(Hi|Hello|Hey)\b/i)?.[1] || "Hi";
    const greeting = recipient && recipient !== "there" ? `${greetingPrefix} ${recipient.split(" ")[0]},` : `${greetingPrefix},`;
    const keyAsk = summary?.keyAsks[0];
    const tone = options.tone || styleProfile.tone || "concise";

    const bodyLines = [greeting, ""];
    if (keyAsk) {
      bodyLines.push(
        tone === "warm"
          ? `Thanks for the note. I took a look at the request about ${keyAsk.replace(/[.?!]$/, "")}.`
          : tone === "executive"
            ? `I reviewed the request regarding ${keyAsk.replace(/[.?!]$/, "")}.`
            : `Thanks for the note. I reviewed the request about ${keyAsk.replace(/[.?!]$/, "")}.`,
      );
    } else {
      bodyLines.push(
        tone === "executive"
          ? `I reviewed the latest update on ${detail.subject.toLowerCase()}.`
          : `Thanks for the update on ${detail.subject.toLowerCase()}.`,
      );
    }

    const scheduleLabels = scheduleSuggestion?.options.map((option) => option.label) || [];

    if (scheduleLabels.length) {
      bodyLines.push("");
      bodyLines.push(
        tone === "executive"
          ? `Available windows: ${scheduleLabels.join(", ")}.`
          : `I can make time for this. A few options on my side: ${scheduleLabels.join(", ")}.`,
      );
    } else if (detail.needsReply) {
      bodyLines.push("");
      bodyLines.push(
        tone === "warm"
          ? "I can take this forward and will follow up with the next concrete step shortly."
          : tone === "executive"
            ? "Next step: I will take this forward and follow up shortly."
            : "I can take this forward and will follow up with the next concrete step shortly.",
      );
    }

    if (styleProfile.styleSignals.length && styleProfile.averageLength < 220) {
      bodyLines.push("");
      bodyLines.push("Keeping this brief and practical.");
    } else if (relationshipContext) {
      const preferenceHint = relationshipContext
        .split("\n")
        .find((line) => line.toLowerCase().includes("feedback preference"));
      if (preferenceHint && !/brief|concise/i.test(tone)) {
        bodyLines.push("");
        bodyLines.push("Keeping this short and practical.");
      }
    }

    bodyLines.push("");
    bodyLines.push(styleProfile.signoff || (tone === "warm" ? "Thanks," : "Best,"));

    const body = bodyLines.join("\n");
    const draftId = randomUUID();
    const now = Date.now();
    const rationale =
      summary?.suggestedNextAction ||
      `Drafted from latest thread context and mailbox memory${styleProfile.styleSignals.length ? ` (${styleProfile.styleSignals.join("; ")})` : ""}.`;
    const scheduleNotes = scheduleSuggestion?.summary;

    this.db
      .prepare(
        `INSERT INTO mailbox_drafts
          (id, thread_id, subject, body_text, tone, rationale, schedule_notes, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draftId,
        threadId,
        detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
        body,
        tone,
        rationale,
        scheduleNotes || null,
        JSON.stringify({
          source: "mailbox-draft-engine",
          includeAvailability: Boolean(scheduleSuggestion),
        }),
        now,
        now,
      );

    this.upsertProposal({
      threadId,
      type: "reply",
      title: "Review reply draft",
      reasoning: rationale,
      preview: {
        draftId,
        subject: detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
      },
    });

    return {
      id: draftId,
      threadId,
      subject: detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
      body,
      tone,
      rationale,
      scheduleNotes,
      createdAt: now,
      updatedAt: now,
    };
  }

  async extractCommitments(threadId: string): Promise<MailboxCommitment[]> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return [];

    const candidates: Array<Pick<MailboxCommitment, "title" | "dueAt" | "sourceExcerpt">> = [];
    for (const message of detail.messages) {
      for (const line of excerptLines(message.body, 12)) {
        if (/\bplease|can you|need to|follow up|action item|todo|deliver\b/i.test(line)) {
          candidates.push({
            title: normalizeWhitespace(line, 180),
            dueAt: parseDueAt(line),
            sourceExcerpt: normalizeWhitespace(line, 180),
          });
        }
      }
    }

    const existingTitles = new Set(
      this.getCommitmentsForThread(threadId).map((item) => item.title.toLowerCase()),
    );
    const created: MailboxCommitment[] = [];
    const now = Date.now();

    for (const candidate of candidates.slice(0, 6)) {
      if (existingTitles.has(candidate.title.toLowerCase())) continue;
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO mailbox_commitments
            (id, thread_id, message_id, title, due_at, state, owner_email, source_excerpt, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          threadId,
          null,
          candidate.title,
          candidate.dueAt || null,
          "suggested",
          detail.participants[0]?.email || null,
          candidate.sourceExcerpt || null,
          JSON.stringify({ source: "mailbox-extraction" }),
          now,
          now,
        );
      RelationshipMemoryService.rememberMailboxInsights({
        commitments: [
          {
            text: candidate.title,
            dueAt: candidate.dueAt,
          },
        ],
      });
      created.push({
        id,
        threadId,
        title: candidate.title,
        dueAt: candidate.dueAt,
        state: "suggested",
        ownerEmail: detail.participants[0]?.email,
        sourceExcerpt: candidate.sourceExcerpt,
        createdAt: now,
        updatedAt: now,
      });
    }

    this.updateContactOpenCommitments(threadId);
    return this.getCommitmentsForThread(threadId);
  }

  async updateCommitmentState(
    commitmentId: string,
    state: MailboxCommitmentState,
  ): Promise<MailboxCommitment | null> {
    const now = Date.now();
    const result = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT
             id,
             thread_id,
             message_id,
             title,
             due_at,
             state,
             owner_email,
             source_excerpt,
             metadata_json,
             created_at,
             updated_at
           FROM mailbox_commitments
           WHERE id = ?`,
        )
        .get(commitmentId) as MailboxCommitmentRow | undefined;
      if (!row) return null;

      const metadata = parseCommitmentMetadata(row.metadata_json);
      let nextMetadata: MailboxCommitmentMetadata = { ...metadata };

      if (state === "accepted") {
        const followUpTask = this.ensureFollowUpTaskForCommitment(row, metadata);
        if (followUpTask) {
          nextMetadata = {
            ...nextMetadata,
            followUpTaskId: followUpTask.id,
            followUpTaskCreatedAt: nextMetadata.followUpTaskCreatedAt ?? now,
            followUpTaskWorkspaceId: nextMetadata.followUpTaskWorkspaceId ?? followUpTask.workspaceId,
          };
          if (row.due_at != null) {
            this.taskRepo.update(followUpTask.id, {
              dueDate: row.due_at,
            });
          }
        }
      }

      if (state === "done" || state === "dismissed") {
        const followUpTaskId = metadata.followUpTaskId;
        if (followUpTaskId) {
          const status = state === "done" ? "completed" : "cancelled";
          this.taskRepo.update(followUpTaskId, {
            status,
            completedAt: state === "done" ? now : undefined,
          });
        }
      }

      this.db
        .prepare(
          `UPDATE mailbox_commitments
           SET state = ?, metadata_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(state, JSON.stringify(nextMetadata), now, commitmentId);

      if (state === "done") {
        const text = row.title;
        const items = RelationshipMemoryService.listOpenCommitments(200);
        for (const item of items) {
          if (
            text.toLowerCase().includes(item.text.toLowerCase()) ||
            item.text.toLowerCase().includes(text.toLowerCase())
          ) {
            RelationshipMemoryService.updateItem(item.id, { status: "done" });
          }
        }
      }

      const updatedRow = this.db
        .prepare(
          `SELECT
             id,
             thread_id,
             message_id,
             title,
             due_at,
             state,
             owner_email,
             source_excerpt,
             metadata_json,
             created_at,
             updated_at
           FROM mailbox_commitments
           WHERE id = ?`,
        )
        .get(commitmentId) as MailboxCommitmentRow | undefined;
      if (!updatedRow) return null;

      this.updateContactOpenCommitments(updatedRow.thread_id);
      return this.mapCommitmentRow(updatedRow);
    })();

    return result;
  }

  async proposeCleanup(limit = 20): Promise<MailboxActionProposal[]> {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           unread_count,
           message_count,
           last_message_at,
           classification_state
         FROM mailbox_threads
         WHERE cleanup_candidate = 1 OR (handled = 1 AND category IN ('promotions', 'updates'))
         ORDER BY last_message_at ASC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 100)) as MailboxThreadRow[];

    for (const row of rows) {
      this.upsertProposal({
        threadId: row.id,
        type: "cleanup",
        title: `Queue cleanup for ${row.subject}`,
        reasoning: "Low-priority handled thread suitable for archive or trash review.",
        preview: {
          threadId: row.id,
          suggestedAction: row.category === "promotions" ? "trash" : "archive",
        },
      });
    }

    return rows.flatMap((row) =>
      this.getProposalsForThread(row.id).filter((proposal) => proposal.type === "cleanup"),
    );
  }

  async proposeFollowups(limit = 20): Promise<MailboxActionProposal[]> {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           unread_count,
           message_count,
           last_message_at,
           classification_state
         FROM mailbox_threads
         WHERE needs_reply = 1 AND stale_followup = 1
         ORDER BY urgency_score DESC, last_message_at ASC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 100)) as MailboxThreadRow[];

    for (const row of rows) {
      this.upsertProposal({
        threadId: row.id,
        type: "follow_up",
        title: `Follow up on ${row.subject}`,
        reasoning: "Thread still needs a response and has been waiting long enough to escalate.",
        preview: {
          threadId: row.id,
          lastMessageAt: row.last_message_at,
        },
      });
    }

    return rows.flatMap((row) =>
      this.getProposalsForThread(row.id).filter((proposal) => proposal.type === "follow_up"),
    );
  }

  async reviewBulkAction(input: MailboxBulkReviewInput): Promise<MailboxBulkReviewResult> {
    const proposals =
      input.type === "cleanup"
        ? await this.proposeCleanup(input.limit)
        : await this.proposeFollowups(input.limit);
    return {
      type: input.type,
      proposals,
      count: proposals.length,
    };
  }

  async scheduleReply(threadId: string): Promise<{ threadId: string; suggestions: string[]; summary: string }> {
    const suggestion = await this.getScheduleSuggestion();
    this.upsertProposal({
      threadId,
      type: "schedule",
      title: "Review suggested meeting slots",
      reasoning: suggestion.summary,
      preview: {
        suggestions: suggestion.options.map((option) => option.label),
        slotOptions: suggestion.options,
      },
    });
    return {
      threadId,
      suggestions: suggestion.options.map((option) => option.label),
      summary: suggestion.summary,
    };
  }

  async researchContact(threadId: string): Promise<MailboxResearchResult | null> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return null;

    const primary = detail.participants[0] || null;
    const domain = primary?.email?.split("@")[1];
    const company = companyFromEmail(primary?.email);
    const contactMemory = this.getPrimaryContactMemory(threadId);
    const relationshipSummary = [
      contactMemory?.responseTendency,
      typeof contactMemory?.averageResponseHours === "number"
        ? `Average response time: ${contactMemory.averageResponseHours.toFixed(1)}h`
        : null,
      contactMemory?.openCommitments ? `${contactMemory.openCommitments} open commitment(s)` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(" · ");
    const nextSteps = [
      detail.needsReply ? "Generate or review a reply draft." : null,
      detail.category === "calendar" ? "Choose one of the proposed time slots and create the event." : null,
      detail.cleanupCandidate ? "Archive or trash after confirming no action is needed." : null,
      !detail.summary ? "Generate an AI summary before replying." : null,
    ].filter((entry): entry is string => Boolean(entry));

    return {
      primaryContact: primary,
      company,
      domain,
      crmHints: contactMemory?.crmLinks || [],
      learnedFacts: contactMemory?.learnedFacts || [],
      recommendedQueries: [
        primary?.email ? `"${primary.email}"` : undefined,
        company ? `${company} leadership` : undefined,
        domain ? `site:${domain} team` : undefined,
        detail.subject ? `"${detail.subject}" ${company || domain || ""}`.trim() : undefined,
      ].filter((entry): entry is string => Boolean(entry)),
      relationshipSummary: relationshipSummary || undefined,
      styleSignals: contactMemory?.styleSignals,
      recentSubjects: contactMemory?.recentSubjects,
      recentOutboundExample: contactMemory?.recentOutboundExample,
      nextSteps,
    };
  }

  async applyAction(input: MailboxApplyActionInput): Promise<{ success: boolean; action: string; threadId?: string }> {
    if (input.type === "dismiss_proposal" && input.proposalId) {
      this.updateProposalStatus(input.proposalId, "dismissed");
      return { success: true, action: input.type };
    }

    const threadId = input.threadId || this.threadIdFromProposal(input.proposalId);
    if (!threadId) {
      throw new Error("Missing threadId or proposalId for mailbox action");
    }

    const thread = await this.getThreadCore(threadId);
    if (!thread) {
      throw new Error("Mailbox thread not found");
    }

    switch (input.type) {
      case "archive":
        await this.applyArchive(thread);
        break;
      case "trash":
        await this.applyTrash(thread);
        break;
      case "mark_read":
        await this.applyMarkRead(thread);
        break;
      case "label":
        if (!input.label) throw new Error("Missing label for label action");
        await this.applyLabel(thread, input.label);
        break;
      case "send_draft":
        await this.applySendDraft(thread, input.draftId);
        break;
      case "discard_draft":
        await this.applyDiscardDraft(thread, input.draftId);
        break;
      case "schedule_event":
        await this.applyScheduleEvent(thread, input.proposalId);
        break;
      default:
        throw new Error(`Unsupported mailbox action: ${input.type}`);
    }

    if (input.proposalId) {
      this.updateProposalStatus(input.proposalId, "applied");
    }

    return {
      success: true,
      action: input.type,
      threadId,
    };
  }

  private async syncGmail(limit: number): Promise<{
    account: MailboxAccount;
    syncedThreads: number;
    syncedMessages: number;
  } | null> {
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled) return null;

    const profileResult = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/profile",
    });
    const emailAddress = asString(profileResult.data?.emailAddress);
    if (!emailAddress) return null;

    const accountId = `gmail:${emailAddress.toLowerCase()}`;
    const now = Date.now();
    const existingAccount = this.db
      .prepare(
        `SELECT classification_initial_batch_at
         FROM mailbox_accounts
         WHERE id = ?`,
      )
      .get(accountId) as { classification_initial_batch_at: number | null } | undefined;
    const initialClassificationNeeded = !existingAccount?.classification_initial_batch_at;
    this.upsertAccount({
      id: accountId,
      provider: "gmail",
      address: emailAddress.toLowerCase(),
      displayName: emailAddress,
      status: "connected",
      capabilities: ["threads", "labels", "drafts", "archive", "trash", "schedule"],
      lastSyncedAt: now,
    });

    const listResult = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/messages",
      query: {
        maxResults: Math.min(Math.max(limit, 5), 50),
        q: "newer_than:30d",
      },
    });

    const messageRefs = (Array.isArray(listResult.data?.messages) ? listResult.data.messages : []) as Array<{
      threadId?: unknown;
    }>;
    const threadIds = Array.from(
      new Set(
        messageRefs
          .map((entry: Any) => asString(entry?.threadId))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    ).slice(0, limit);

    const classificationCandidates: string[] = [];
    let syncedMessages = 0;
    let processedThreads = 0;
    this.updateSyncProgress({
      phase: "ingesting",
      accountId,
      totalThreads: threadIds.length,
      processedThreads: 0,
      totalMessages: 0,
      processedMessages: 0,
      newThreads: 0,
      classifiedThreads: 0,
      skippedThreads: 0,
      label:
        threadIds.length > 0
          ? `Syncing 0/${threadIds.length} thread${threadIds.length === 1 ? "" : "s"}...`
          : "No new threads found",
    });

    for (const threadId of threadIds) {
      const threadResult = await gmailRequest(settings, {
        method: "GET",
        path: `/users/me/threads/${threadId}`,
        query: {
          format: "full",
        },
      });
      const normalized = this.normalizeGmailThread(accountId, emailAddress.toLowerCase(), threadResult.data);
      if (!normalized) continue;
      const upsertResult = this.upsertThread(normalized);
      if (upsertResult.shouldClassify) {
        classificationCandidates.push(normalized.id);
      }
      syncedMessages += normalized.messages.length;
      processedThreads += 1;
      this.updateSyncProgress({
        phase: "ingesting",
        accountId,
        totalThreads: threadIds.length,
        processedThreads,
        totalMessages: Math.max(syncedMessages, processedThreads),
        processedMessages: syncedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: Math.max(0, threadIds.length - processedThreads),
        label:
          threadIds.length > 0
            ? `Syncing ${processedThreads}/${threadIds.length} thread${threadIds.length === 1 ? "" : "s"} · ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}`
            : "No new threads found",
      });
    }

    if (initialClassificationNeeded) {
      this.updateSyncProgress({
        phase: "classifying",
        accountId,
        totalThreads: threadIds.length,
        processedThreads,
        totalMessages: syncedMessages,
        processedMessages: syncedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: 0,
        label:
          classificationCandidates.length > 0
            ? `Classifying initial batch of ${classificationCandidates.length} thread${classificationCandidates.length === 1 ? "" : "s"}`
            : "Initial classification complete",
      });
      await this.classifyMailboxThreadsForAccount(accountId, {
        limit: MAILBOX_CLASSIFIER_MAX_BATCH,
      });
    } else if (classificationCandidates.length > 0) {
      let classifiedThreads = 0;
      this.updateSyncProgress({
        phase: "classifying",
        accountId,
        totalThreads: threadIds.length,
        processedThreads,
        totalMessages: syncedMessages,
        processedMessages: syncedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: 0,
        label: `Classifying ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`,
      });
      for (const candidateThreadId of classificationCandidates) {
        await this.classifyThreadById(candidateThreadId);
        classifiedThreads += 1;
        this.updateSyncProgress({
          phase: "classifying",
          accountId,
          totalThreads: threadIds.length,
          processedThreads,
          totalMessages: syncedMessages,
          processedMessages: syncedMessages,
          newThreads: classificationCandidates.length,
          classifiedThreads,
          skippedThreads: 0,
          label:
            classifiedThreads < classificationCandidates.length
              ? `Classifying ${classifiedThreads}/${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`
              : `Classified ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}`,
        });
      }
    } else {
      this.updateSyncProgress({
        phase: "done",
        accountId,
        totalThreads: threadIds.length,
        processedThreads,
        totalMessages: syncedMessages,
        processedMessages: syncedMessages,
        newThreads: 0,
        classifiedThreads: 0,
        skippedThreads: 0,
        label:
          threadIds.length > 0
            ? `Synced ${threadIds.length} thread${threadIds.length === 1 ? "" : "s"} and ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}`
          : "Mailbox sync complete",
      });
    }

    this.updateSyncProgress({
      phase: "done",
      accountId,
      totalThreads: threadIds.length,
      processedThreads,
      totalMessages: syncedMessages,
      processedMessages: syncedMessages,
      newThreads: classificationCandidates.length,
      classifiedThreads: classificationCandidates.length,
      skippedThreads: 0,
      label:
        threadIds.length > 0
          ? `Synced ${threadIds.length} thread${threadIds.length === 1 ? "" : "s"} and ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}`
          : "Mailbox sync complete",
    });

    return {
      account: this.mapAccountRow(
        this.db
          .prepare(
            `SELECT id, provider, address, display_name, status, capabilities_json, classification_initial_batch_at, last_synced_at
             FROM mailbox_accounts WHERE id = ?`,
          )
          .get(accountId) as MailboxAccountRow,
      ),
      syncedThreads: threadIds.length,
      syncedMessages,
    };
  }

  private normalizeGmailThread(
    accountId: string,
    accountEmail: string,
    thread: Any,
  ): NormalizedThreadInput | null {
    const threadId = asString(thread?.id);
    const messagesRaw = Array.isArray(thread?.messages) ? thread.messages : [];
    if (!threadId || messagesRaw.length === 0) return null;

    const messages: NormalizedMailboxMessage[] = messagesRaw.map(
      (message: Any): NormalizedMailboxMessage => {
        const payload = asObject(message?.payload) || {};
        const headers = Array.isArray(payload.headers) ? payload.headers : [];
        const subject = extractGmailHeader(headers, "Subject") || "(No subject)";
        const fromRaw = extractGmailHeader(headers, "From");
        const toRaw = extractGmailHeader(headers, "To");
        const ccRaw = extractGmailHeader(headers, "Cc");
        const bccRaw = extractGmailHeader(headers, "Bcc");
        const internalDate = Number(message?.internalDate || Date.now());
        const body = extractGmailBody(payload);
        const bodyHtml = extractGmailHtml(payload) || undefined;
        const snippet = normalizeWhitespace(asString(message?.snippet) || body || subject, 260);
        const fromEmail = normalizeEmailAddress(fromRaw);
        const direction = fromEmail === accountEmail ? "outgoing" : "incoming";
        return {
          id: `gmail-message:${asString(message?.id) || randomUUID()}`,
          providerMessageId: asString(message?.id) || randomUUID(),
          direction,
          from: fromEmail
            ? {
                email: fromEmail,
                name: extractDisplayName(fromRaw || undefined),
              }
            : undefined,
          to: parseAddressList(toRaw),
          cc: parseAddressList(ccRaw),
          bcc: parseAddressList(bccRaw),
          subject,
          snippet,
          body,
          bodyHtml,
          receivedAt: Number.isFinite(internalDate) ? internalDate : Date.now(),
          unread: Array.isArray(message?.labelIds) ? message.labelIds.includes("UNREAD") : false,
        };
      },
    );
    messages.sort((a: NormalizedMailboxMessage, b: NormalizedMailboxMessage) => a.receivedAt - b.receivedAt);

    const latest = messages[messages.length - 1];
    const labels = Array.isArray(messagesRaw[messagesRaw.length - 1]?.labelIds)
      ? (messagesRaw[messagesRaw.length - 1].labelIds as string[])
      : [];
    const participants = uniqueParticipants(
      messages.flatMap((message) => [
        ...(message.from ? [message.from] : []),
        ...message.to,
        ...message.cc,
      ]),
    ).filter((participant) => participant.email !== accountEmail);
    const unreadCount = messages.filter((message) => message.unread).length;
    const category: MailboxThreadCategory = "other";
    const needsReply = false;
    const cleanupCandidate = false;
    const scoring = {
      priorityScore: clampScore(unreadCount > 0 ? 25 : 5),
      urgencyScore: clampScore(unreadCount > 0 ? 10 : 0),
      staleFollowup: false,
      handled: unreadCount === 0,
    };

    return {
      id: `gmail-thread:${threadId}`,
      accountId,
      provider: "gmail",
      providerThreadId: threadId,
      subject: latest.subject,
      snippet: latest.snippet,
      participants,
      labels,
      category,
      priorityScore: scoring.priorityScore,
      urgencyScore: scoring.urgencyScore,
      needsReply,
      staleFollowup: scoring.staleFollowup,
      cleanupCandidate,
      handled: scoring.handled,
      unreadCount,
      lastMessageAt: latest.receivedAt,
      messages,
    };
  }

  private async syncImap(limit: number): Promise<{
    account: MailboxAccount;
    syncedThreads: number;
    syncedMessages: number;
  } | null> {
    const channel = this.channelRepo.findByType("email");
    if (!channel || !channel.enabled) return null;
    const cfg = (channel.config as Any) || {};
    const protocol = asString(cfg.protocol) === "loom" ? "loom" : "imap-smtp";
    const now = Date.now();

    if (protocol === "loom") {
      const loomBaseUrl = asString(cfg.loomBaseUrl);
      const accessToken = asString(cfg.loomAccessToken);
      const identity = asString(cfg.loomIdentity) || loomBaseUrl;
      if (!loomBaseUrl || !accessToken || !identity) return null;
      const mailbox = asString(cfg.loomMailboxFolder) || "INBOX";
      const client = new LoomEmailClient({
        baseUrl: loomBaseUrl,
        accessTokenProvider: () => accessToken,
        identity,
        folder: assertSafeLoomMailboxFolder(mailbox),
        pollInterval: asNumber(cfg.loomPollInterval) ?? 30000,
        verbose: process.env.NODE_ENV === "development",
      });
      const messages = await client.fetchUnreadEmails(Math.min(Math.max(limit, 5), 50));
      const accountId = `imap:${identity.toLowerCase()}`;
      const existingAccount = this.db
        .prepare(
          `SELECT classification_initial_batch_at
           FROM mailbox_accounts
           WHERE id = ?`,
        )
        .get(accountId) as { classification_initial_batch_at: number | null } | undefined;
      const initialClassificationNeeded = !existingAccount?.classification_initial_batch_at;
      this.upsertAccount({
        id: accountId,
        provider: "imap",
        address: identity.toLowerCase(),
        displayName: identity,
        status: "connected",
        capabilities: ["send", "mark_read"],
        lastSyncedAt: now,
      });
      const threads = this.normalizeImapThreads(accountId, identity.toLowerCase(), messages);
      const classificationCandidates: string[] = [];
      let processedThreads = 0;
      let processedMessages = 0;
      this.updateSyncProgress({
        phase: "ingesting",
        accountId,
        totalThreads: threads.length,
        processedThreads: 0,
        totalMessages: messages.length,
        processedMessages: 0,
        newThreads: 0,
        classifiedThreads: 0,
        skippedThreads: 0,
        label:
          threads.length > 0
            ? `Syncing 0/${threads.length} thread${threads.length === 1 ? "" : "s"}...`
            : "No new threads found",
      });
      for (const thread of threads) {
        const upsertResult = this.upsertThread(thread);
        if (upsertResult.shouldClassify) {
          classificationCandidates.push(thread.id);
        }
        processedThreads += 1;
        processedMessages += thread.messages.length;
        this.updateSyncProgress({
          phase: "ingesting",
          accountId,
          totalThreads: threads.length,
          processedThreads,
          totalMessages: messages.length,
          processedMessages,
          newThreads: classificationCandidates.length,
          classifiedThreads: 0,
          skippedThreads: Math.max(0, threads.length - processedThreads),
          label:
            threads.length > 0
              ? `Syncing ${processedThreads}/${threads.length} thread${threads.length === 1 ? "" : "s"} · ${processedMessages} message${processedMessages === 1 ? "" : "s"}`
              : "No new threads found",
        });
      }
      if (initialClassificationNeeded) {
        this.updateSyncProgress({
          phase: "classifying",
          accountId,
          totalThreads: threads.length,
          processedThreads,
          totalMessages: messages.length,
          processedMessages,
          newThreads: classificationCandidates.length,
          classifiedThreads: 0,
          skippedThreads: 0,
          label:
            classificationCandidates.length > 0
              ? `Classifying initial batch of ${classificationCandidates.length} thread${classificationCandidates.length === 1 ? "" : "s"}`
              : "Initial classification complete",
        });
        await this.classifyMailboxThreadsForAccount(accountId, {
          limit: MAILBOX_CLASSIFIER_MAX_BATCH,
        });
      } else {
        let classifiedThreads = 0;
        if (classificationCandidates.length > 0) {
          this.updateSyncProgress({
            phase: "classifying",
            accountId,
            totalThreads: threads.length,
            processedThreads,
            totalMessages: messages.length,
            processedMessages,
            newThreads: classificationCandidates.length,
            classifiedThreads: 0,
            skippedThreads: 0,
            label: `Classifying ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`,
          });
          for (const candidateThreadId of classificationCandidates) {
            await this.classifyThreadById(candidateThreadId);
            classifiedThreads += 1;
            this.updateSyncProgress({
              phase: "classifying",
              accountId,
              totalThreads: threads.length,
              processedThreads,
              totalMessages: messages.length,
              processedMessages,
              newThreads: classificationCandidates.length,
              classifiedThreads,
              skippedThreads: 0,
              label:
                classifiedThreads < classificationCandidates.length
                  ? `Classifying ${classifiedThreads}/${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`
                  : `Classified ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}`,
            });
          }
        }
      }
      this.updateSyncProgress({
        phase: "done",
        accountId,
        totalThreads: threads.length,
        processedThreads,
        totalMessages: messages.length,
        processedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: classificationCandidates.length,
        skippedThreads: 0,
        label:
          threads.length > 0
            ? `Synced ${threads.length} thread${threads.length === 1 ? "" : "s"} and ${messages.length} message${messages.length === 1 ? "" : "s"}`
            : "Mailbox sync complete",
      });
      return {
        account: this.mapAccountRow(
          this.db
            .prepare(
              `SELECT id, provider, address, display_name, status, capabilities_json, classification_initial_batch_at, last_synced_at
               FROM mailbox_accounts WHERE id = ?`,
            )
            .get(accountId) as MailboxAccountRow,
        ),
        syncedThreads: threads.length,
        syncedMessages: messages.length,
      };
    }

    const email = asString(cfg.email);
    const password = asString(cfg.password);
    const imapHost = asString(cfg.imapHost);
    const smtpHost = asString(cfg.smtpHost);
    if (!email || !password || !imapHost || !smtpHost) return null;

    const client = new EmailClient({
      imapHost,
      imapPort: asNumber(cfg.imapPort) ?? 993,
      imapSecure: asBoolean(cfg.imapSecure) ?? true,
      smtpHost,
      smtpPort: asNumber(cfg.smtpPort) ?? 587,
      smtpSecure: asBoolean(cfg.smtpSecure) ?? false,
      email,
      password,
      displayName: asString(cfg.displayName) || undefined,
      mailbox: asString(cfg.mailbox) || "INBOX",
      pollInterval: 30000,
      verbose: process.env.NODE_ENV === "development",
    });
    const messages = await client.fetchUnreadEmails(Math.min(Math.max(limit, 5), 50));
    const accountId = `imap:${email.toLowerCase()}`;
    const existingAccount = this.db
      .prepare(
        `SELECT classification_initial_batch_at
         FROM mailbox_accounts
         WHERE id = ?`,
      )
      .get(accountId) as { classification_initial_batch_at: number | null } | undefined;
    const initialClassificationNeeded = !existingAccount?.classification_initial_batch_at;
    this.upsertAccount({
      id: accountId,
      provider: "imap",
      address: email.toLowerCase(),
      displayName: email,
      status: "connected",
      capabilities: ["send", "mark_read"],
      lastSyncedAt: now,
    });
    const threads = this.normalizeImapThreads(accountId, email.toLowerCase(), messages);
    const classificationCandidates: string[] = [];
    let processedThreads = 0;
    let processedMessages = 0;
    this.updateSyncProgress({
      phase: "ingesting",
      accountId,
      totalThreads: threads.length,
      processedThreads: 0,
      totalMessages: messages.length,
      processedMessages: 0,
      newThreads: 0,
      classifiedThreads: 0,
      skippedThreads: 0,
      label:
        threads.length > 0
          ? `Syncing 0/${threads.length} thread${threads.length === 1 ? "" : "s"}...`
          : "No new threads found",
    });
    for (const thread of threads) {
      const upsertResult = this.upsertThread(thread);
      if (upsertResult.shouldClassify) {
        classificationCandidates.push(thread.id);
      }
      processedThreads += 1;
      processedMessages += thread.messages.length;
      this.updateSyncProgress({
        phase: "ingesting",
        accountId,
        totalThreads: threads.length,
        processedThreads,
        totalMessages: messages.length,
        processedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: Math.max(0, threads.length - processedThreads),
        label:
          threads.length > 0
            ? `Syncing ${processedThreads}/${threads.length} thread${threads.length === 1 ? "" : "s"} · ${processedMessages} message${processedMessages === 1 ? "" : "s"}`
            : "No new threads found",
      });
    }
    if (initialClassificationNeeded) {
      this.updateSyncProgress({
        phase: "classifying",
        accountId,
        totalThreads: threads.length,
        processedThreads,
        totalMessages: messages.length,
        processedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: 0,
        label:
          classificationCandidates.length > 0
            ? `Classifying initial batch of ${classificationCandidates.length} thread${classificationCandidates.length === 1 ? "" : "s"}`
            : "Initial classification complete",
      });
      await this.classifyMailboxThreadsForAccount(accountId, {
        limit: MAILBOX_CLASSIFIER_MAX_BATCH,
      });
    } else if (classificationCandidates.length > 0) {
      let classifiedThreads = 0;
      this.updateSyncProgress({
        phase: "classifying",
        accountId,
        totalThreads: threads.length,
        processedThreads,
        totalMessages: messages.length,
        processedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: 0,
        label: `Classifying ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`,
      });
      for (const candidateThreadId of classificationCandidates) {
        await this.classifyThreadById(candidateThreadId);
        classifiedThreads += 1;
        this.updateSyncProgress({
          phase: "classifying",
          accountId,
          totalThreads: threads.length,
          processedThreads,
          totalMessages: messages.length,
          processedMessages,
          newThreads: classificationCandidates.length,
          classifiedThreads,
          skippedThreads: 0,
          label:
            classifiedThreads < classificationCandidates.length
              ? `Classifying ${classifiedThreads}/${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`
              : `Classified ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}`,
        });
      }
    }

    this.updateSyncProgress({
      phase: "done",
      accountId,
      totalThreads: threads.length,
      processedThreads,
      totalMessages: messages.length,
      processedMessages,
      newThreads: classificationCandidates.length,
      classifiedThreads: classificationCandidates.length,
      skippedThreads: 0,
      label:
        threads.length > 0
          ? `Synced ${threads.length} thread${threads.length === 1 ? "" : "s"} and ${messages.length} message${messages.length === 1 ? "" : "s"}`
          : "Mailbox sync complete",
    });

    return {
      account: this.mapAccountRow(
        this.db
          .prepare(
            `SELECT id, provider, address, display_name, status, capabilities_json, classification_initial_batch_at, last_synced_at
             FROM mailbox_accounts WHERE id = ?`,
          )
          .get(accountId) as MailboxAccountRow,
      ),
      syncedThreads: threads.length,
      syncedMessages: messages.length,
    };
  }

  private normalizeImapThreads(
    accountId: string,
    accountEmail: string,
    messagesRaw: Any[],
  ): NormalizedThreadInput[] {
    const groups = new Map<string, Any[]>();
    for (const message of messagesRaw) {
      const subject = normalizeWhitespace(asString(message?.subject) || "(No subject)", 160);
      const from = normalizeEmailAddress(message?.from);
      const key = `${subject.toLowerCase()}::${from || "unknown"}`;
      const bucket = groups.get(key) || [];
      bucket.push(message);
      groups.set(key, bucket);
    }

    return Array.from(groups.entries()).map(([groupKey, group]: [string, Any[]]) => {
      const normalizedMessages: NormalizedMailboxMessage[] = group.map(
        (message: Any): NormalizedMailboxMessage => {
          const fromEmail = normalizeEmailAddress(message?.from);
          const body = normalizeWhitespace(asString(message?.text) || asString(message?.snippet) || "", 4000);
          const subject = normalizeWhitespace(asString(message?.subject) || "(No subject)", 160);
          return {
            id: `imap-message:${asString(message?.uid) || randomUUID()}`,
            providerMessageId: String(message?.uid || message?.messageId || randomUUID()),
            direction: fromEmail === accountEmail ? ("outgoing" as const) : ("incoming" as const),
            from: fromEmail
              ? {
                  email: fromEmail,
                  name: extractDisplayName(message?.from),
                }
              : undefined,
            to: parseAddressList(message?.to),
            cc: [],
            bcc: [],
            subject,
            snippet: normalizeWhitespace(asString(message?.snippet) || body || subject, 260),
            body,
            receivedAt: new Date(message?.date || Date.now()).getTime(),
            unread: !message?.isRead,
          };
        },
      );
      normalizedMessages.sort((a: NormalizedMailboxMessage, b: NormalizedMailboxMessage) => a.receivedAt - b.receivedAt);

      const latest = normalizedMessages[normalizedMessages.length - 1];
      const participants = uniqueParticipants(
        normalizedMessages.flatMap((message) => [
          ...(message.from ? [message.from] : []),
          ...message.to,
        ]),
      ).filter((participant) => participant.email !== accountEmail);
      const unreadCount = normalizedMessages.filter((message) => message.unread).length;
      const category: MailboxThreadCategory = "other";
      const needsReply = false;
      const cleanupCandidate = false;
      const scoring = {
        priorityScore: clampScore(unreadCount > 0 ? 25 : 5),
        urgencyScore: clampScore(unreadCount > 0 ? 10 : 0),
        staleFollowup: false,
        handled: unreadCount === 0,
      };

      return {
        id: `imap-thread:${groupKey}`,
        accountId,
        provider: "imap" as const,
        providerThreadId: groupKey,
        subject: latest.subject,
        snippet: latest.snippet,
        participants,
        labels: [],
        category,
        priorityScore: scoring.priorityScore,
        urgencyScore: scoring.urgencyScore,
        needsReply,
        staleFollowup: scoring.staleFollowup,
        cleanupCandidate,
        handled: scoring.handled,
        unreadCount,
        lastMessageAt: latest.receivedAt,
        messages: normalizedMessages,
      };
    });
  }

  private upsertAccount(account: MailboxAccount): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mailbox_accounts
          (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           address = excluded.address,
           display_name = excluded.display_name,
           status = excluded.status,
           capabilities_json = excluded.capabilities_json,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        account.id,
        account.provider,
        account.address,
        account.displayName || null,
        account.status,
        JSON.stringify(account.capabilities),
        null,
        account.lastSyncedAt || null,
        now,
        now,
      );
  }

  private upsertThread(thread: NormalizedThreadInput): ThreadUpsertResult {
    const now = Date.now();
    const fingerprint = mailboxClassificationFingerprint({
      threadId: thread.id,
      accountId: thread.accountId,
      provider: thread.provider,
      subject: thread.subject,
      snippet: thread.snippet,
      unreadCount: thread.unreadCount,
      participants: thread.participants,
      labels: thread.labels,
      lastMessageAt: thread.lastMessageAt,
      messageCount: thread.messages.length,
      messages: thread.messages.slice(-MAILBOX_CLASSIFIER_MAX_MESSAGES).map((message) => ({
        direction: message.direction,
        from: message.from,
        snippet: message.snippet,
        body: message.bodyHtml ? stripHtml(message.bodyHtml) : message.body,
        receivedAt: message.receivedAt,
        unread: message.unread,
      })),
    });
    const existing = this.db
      .prepare(
        `SELECT
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           classification_state,
           classification_fingerprint,
           classification_model_key,
           classification_prompt_version,
           classification_confidence,
           classification_updated_at,
           classification_error,
           classification_json /* raw LLM response — debug/replay only, not used in runtime logic */
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(thread.id) as
      | {
          category: MailboxThreadCategory;
          priority_score: number;
          urgency_score: number;
          needs_reply: number;
          stale_followup: number;
          cleanup_candidate: number;
          handled: number;
          classification_state: MailboxClassificationState;
          classification_fingerprint: string | null;
          classification_model_key: string | null;
          classification_prompt_version: string | null;
          classification_confidence: number;
          classification_updated_at: number | null;
          classification_error: string | null;
          /** Raw LLM JSON response — stored for debugging/replay only; not used in runtime logic. */
          classification_json: string | null;
        }
      | undefined;
    const isNewThread = !existing;
    const keepExistingClassification =
      existing?.classification_state === "classified" &&
      existing.classification_fingerprint === fingerprint &&
      existing.classification_prompt_version === MAILBOX_CLASSIFIER_PROMPT_VERSION;
    const preserveBackfillState =
      !keepExistingClassification &&
      existing?.classification_state === "backfill_pending" &&
      existing.classification_fingerprint === fingerprint;
    const nextClassificationState: MailboxClassificationState = keepExistingClassification
      ? "classified"
      : preserveBackfillState
        ? "backfill_pending"
        : "pending";
    const classificationValues = keepExistingClassification || preserveBackfillState ? existing : null;
    const shouldClassify = !existing || existing.classification_fingerprint !== fingerprint;

    this.db
      .prepare(
        `INSERT INTO mailbox_threads
          (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, classification_state, classification_fingerprint, classification_model_key, classification_prompt_version, classification_confidence, classification_updated_at, classification_error, classification_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           account_id = excluded.account_id,
           provider_thread_id = excluded.provider_thread_id,
           provider = excluded.provider,
           subject = excluded.subject,
           snippet = excluded.snippet,
           participants_json = excluded.participants_json,
           labels_json = excluded.labels_json,
           category = excluded.category,
           priority_score = excluded.priority_score,
           urgency_score = excluded.urgency_score,
           needs_reply = excluded.needs_reply,
           stale_followup = excluded.stale_followup,
           cleanup_candidate = excluded.cleanup_candidate,
           handled = excluded.handled,
           unread_count = excluded.unread_count,
           message_count = excluded.message_count,
           last_message_at = excluded.last_message_at,
           last_synced_at = excluded.last_synced_at,
           classification_state = excluded.classification_state,
           classification_fingerprint = excluded.classification_fingerprint,
           classification_model_key = excluded.classification_model_key,
           classification_prompt_version = excluded.classification_prompt_version,
           classification_confidence = excluded.classification_confidence,
           classification_updated_at = excluded.classification_updated_at,
           classification_error = excluded.classification_error,
           classification_json = excluded.classification_json,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        thread.id,
        thread.accountId,
        thread.providerThreadId,
        thread.provider,
        thread.subject,
        thread.snippet,
        JSON.stringify(thread.participants),
        JSON.stringify(thread.labels),
        classificationValues?.category || thread.category,
        classificationValues?.priority_score ?? thread.priorityScore,
        classificationValues?.urgency_score ?? thread.urgencyScore,
        classificationValues?.needs_reply ?? (thread.needsReply ? 1 : 0),
        classificationValues?.stale_followup ?? (thread.staleFollowup ? 1 : 0),
        classificationValues?.cleanup_candidate ?? (thread.cleanupCandidate ? 1 : 0),
        classificationValues?.handled ?? (thread.handled ? 1 : 0),
        thread.unreadCount,
        thread.messages.length,
        thread.lastMessageAt,
        now,
        nextClassificationState,
        fingerprint,
        classificationValues?.classification_model_key || null,
        classificationValues?.classification_prompt_version || null,
        classificationValues?.classification_confidence ?? 0,
        classificationValues?.classification_updated_at || null,
        classificationValues?.classification_error || null,
        classificationValues?.classification_json || null,
        JSON.stringify({
          priorityBand: priorityBandFromScore(classificationValues?.priority_score ?? thread.priorityScore),
        }),
        now,
        now,
      );

    for (const message of thread.messages) {
      this.db
        .prepare(
          `INSERT INTO mailbox_messages
            (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, body_html, received_at, is_unread, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             provider_message_id = excluded.provider_message_id,
             direction = excluded.direction,
             from_name = excluded.from_name,
             from_email = excluded.from_email,
             to_json = excluded.to_json,
             cc_json = excluded.cc_json,
             bcc_json = excluded.bcc_json,
             subject = excluded.subject,
             snippet = excluded.snippet,
             body_text = excluded.body_text,
             body_html = excluded.body_html,
             received_at = excluded.received_at,
             is_unread = excluded.is_unread,
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          message.id,
          thread.id,
          message.providerMessageId,
          message.direction,
          message.from?.name || null,
          message.from?.email || null,
          JSON.stringify(message.to),
          JSON.stringify(message.cc),
          JSON.stringify(message.bcc),
          message.subject,
          message.snippet,
          message.body,
          message.bodyHtml || null,
          message.receivedAt,
          message.unread ? 1 : 0,
          JSON.stringify({}),
          now,
          now,
        );
    }

    this.upsertPrimaryContact(thread);
    RelationshipMemoryService.rememberMailboxInsights({
      facts: thread.participants
        .slice(0, 1)
        .map((participant) => `Recent email contact: ${participant.name || participant.email}`),
    });
    if (keepExistingClassification) {
      this.refreshThreadProposals({
        id: thread.id,
        subject: thread.subject,
        needsReply: Boolean(classificationValues?.needs_reply),
        cleanupCandidate: Boolean(classificationValues?.cleanup_candidate),
        staleFollowup: Boolean(classificationValues?.stale_followup),
        category: classificationValues?.category || thread.category,
      });
    } else {
      this.db
      .prepare(
          `DELETE FROM mailbox_action_proposals
           WHERE thread_id = ?
             AND status = 'suggested'
             AND proposal_type IN ('reply', 'cleanup', 'follow_up', 'schedule')`,
        )
        .run(thread.id);
    }

    return {
      shouldClassify,
      isNewThread,
    };
  }

  private buildClassificationSnapshot(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
  ): MailboxClassificationSnapshot {
    return {
      threadId: thread.id,
      accountId: thread.accountId,
      provider: thread.provider,
      subject: thread.subject,
      snippet: thread.snippet,
      unreadCount: thread.unreadCount,
      categoryHint: thread.category,
      participants: thread.participants,
      labels: thread.labels,
      lastMessageAt: thread.lastMessageAt,
      messageCount: thread.messageCount,
      messages: thread.messages.slice(-MAILBOX_CLASSIFIER_MAX_MESSAGES).map((message) => ({
        direction: message.direction,
        from: message.from,
        snippet: message.snippet,
        body: message.bodyHtml ? stripHtml(message.bodyHtml) : message.body,
        receivedAt: message.receivedAt,
        unread: message.unread,
      })),
    };
  }

  private chooseMailboxClassifierModel(): { providerType: string; modelKey: string; modelId: string } | null {
    try {
      const settings = LLMProviderFactory.loadSettings();
      const providerType = settings.providerType;
      const routing = LLMProviderFactory.getProviderRoutingSettings(settings, providerType);
      const preferredKey =
        routing.automatedTaskModelKey || routing.cheapModelKey || settings.modelKey || "";
      if (!preferredKey) return null;
      const selection = LLMProviderFactory.resolveTaskModelSelection({
        providerType,
        modelKey: preferredKey,
      });
      return {
        providerType: selection.providerType,
        modelKey: selection.modelKey,
        modelId: selection.modelId,
      };
    } catch {
      return null;
    }
  }

  private parseClassificationResponse(text: string): MailboxClassificationResult | null {
    const jsonText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    if (!jsonText.startsWith("{")) return null;
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const category = String(parsed.category || "").toLowerCase();
      const validCategory: MailboxThreadCategory = [
        "priority",
        "calendar",
        "follow_up",
        "promotions",
        "updates",
        "personal",
        "other",
      ].includes(category)
        ? (category as MailboxThreadCategory)
        : "other";
      const confidence = clampConfidence(Number(parsed.confidence ?? 0));
      if (confidence < MAILBOX_CLASSIFIER_MIN_CONFIDENCE) {
        return null;
      }
      return {
        category: validCategory,
        needsReply: parsed.needsReply === true,
        priorityScore: clampScore(Number(parsed.priorityScore ?? 0)),
        urgencyScore: clampScore(Number(parsed.urgencyScore ?? 0)),
        staleFollowup: parsed.staleFollowup === true,
        cleanupCandidate: parsed.cleanupCandidate === true,
        handled: parsed.handled === true,
        confidence,
        rationale: typeof parsed.rationale === "string" ? normalizeWhitespace(parsed.rationale, 220) : undefined,
        labels: Array.isArray(parsed.labels)
          ? parsed.labels.filter((label): label is string => typeof label === "string")
          : undefined,
      };
    } catch {
      return null;
    }
  }

  private async classifyThreadWithLLM(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    options?: { force?: boolean },
  ): Promise<MailboxClassificationResult | null> {
    const snapshot = this.buildClassificationSnapshot(thread);
    const fingerprint = mailboxClassificationFingerprint(snapshot);
    const existing = this.db
      .prepare(
        `SELECT classification_state, classification_fingerprint, classification_prompt_version
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(thread.id) as
      | {
          classification_state: MailboxClassificationState;
          classification_fingerprint: string | null;
          classification_prompt_version: string | null;
        }
      | undefined;

    if (
      !options?.force &&
      existing?.classification_state === "classified" &&
      existing.classification_fingerprint === fingerprint &&
      existing.classification_prompt_version === MAILBOX_CLASSIFIER_PROMPT_VERSION
    ) {
      return null;
    }

    const modelSelection = this.chooseMailboxClassifierModel();
    if (!modelSelection) {
      return mailboxClassificationFallback(snapshot);
    }

    const provider = LLMProviderFactory.createProvider();
    const system = [
      "You classify inbox threads for triage.",
      "Return compact strict JSON only with this shape:",
      '{ "category": "priority|calendar|follow_up|promotions|updates|personal|other", "needsReply": boolean, "priorityScore": number, "urgencyScore": number, "staleFollowup": boolean, "cleanupCandidate": boolean, "handled": boolean, "confidence": number, "rationale": string, "labels": string[] }',
      "Use unreadCount only as a weak signal. Do not mark a thread as needsReply for receipts, security alerts, verification codes, password resets, onboarding, or automated account notifications unless the sender explicitly asks the user to respond.",
      "Treat priority as business urgency, not sender importance.",
      "Keep scores in the 0 to 100 range and confidence in the 0 to 1 range.",
      "Prefer false negatives over false positives for needsReply.",
      "Keep rationale under 160 characters and labels under 6 items.",
    ].join(" ");

    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                threadId: snapshot.threadId,
                provider: snapshot.provider,
                subject: snapshot.subject,
                snippet: snapshot.snippet,
                unreadCount: snapshot.unreadCount,
                categoryHint: snapshot.categoryHint,
                labels: snapshot.labels,
                participants: snapshot.participants,
                lastMessageAt: snapshot.lastMessageAt,
                messageCount: snapshot.messageCount,
                messages: snapshot.messages.map((message) => ({
                  direction: message.direction,
                  from: message.from,
                  receivedAt: message.receivedAt,
                  unread: message.unread,
                  snippet: message.snippet,
                  body: summarizeMailboxBody(message.body),
                })),
              },
              null,
              2,
            ),
          },
        ],
      },
    ];

    try {
      const response = await provider.createMessage({
        model: modelSelection.modelId,
        maxTokens: MAILBOX_CLASSIFIER_MAX_TOKENS,
        system,
        messages,
      });
      const text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trim();
      const parsed = this.parseClassificationResponse(text);
      if (!parsed) {
        return mailboxClassificationFallback(snapshot);
      }
      return parsed;
    } catch {
      return mailboxClassificationFallback(snapshot);
    }
  }

  private persistThreadClassification(
    threadId: string,
    result: MailboxClassificationResult,
    fingerprint: string,
    modelKey: string | null,
    existingState: MailboxClassificationState,
    rawJson?: string,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE mailbox_threads
         SET category = ?,
             priority_score = ?,
             urgency_score = ?,
             needs_reply = ?,
             stale_followup = ?,
             cleanup_candidate = ?,
             handled = ?,
             classification_state = 'classified',
             classification_fingerprint = ?,
             classification_model_key = ?,
             classification_prompt_version = ?,
             classification_confidence = ?,
             classification_updated_at = ?,
             classification_error = NULL,
             classification_json = ?,
             metadata_json = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        result.category,
        clampScore(result.priorityScore),
        clampScore(result.urgencyScore),
        result.needsReply ? 1 : 0,
        result.staleFollowup ? 1 : 0,
        result.cleanupCandidate ? 1 : 0,
        result.handled ? 1 : 0,
        fingerprint,
        modelKey,
        MAILBOX_CLASSIFIER_PROMPT_VERSION,
        clampConfidence(result.confidence),
        now,
        rawJson || JSON.stringify(result),
        JSON.stringify({
          priorityBand: priorityBandFromScore(result.priorityScore),
          classification: {
            state: "classified",
            modelKey,
            promptVersion: MAILBOX_CLASSIFIER_PROMPT_VERSION,
            confidence: clampConfidence(result.confidence),
            fingerprint,
            classifiedAt: now,
            previousState: existingState,
          },
        }),
        now,
        threadId,
      );
  }

  private async classifyThreadById(
    threadId: string,
    options?: { force?: boolean; preserveBackfill?: boolean },
  ): Promise<boolean> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return false;
    const snapshot = this.buildClassificationSnapshot(detail);
    const fingerprint = mailboxClassificationFingerprint(snapshot);
    const existing = this.db
      .prepare(
        `SELECT classification_state, classification_fingerprint, classification_prompt_version
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(threadId) as
      | {
          classification_state: MailboxClassificationState;
          classification_fingerprint: string | null;
          classification_prompt_version: string | null;
        }
      | undefined;

    if (
      !options?.force &&
      existing?.classification_state === "classified" &&
      existing.classification_fingerprint === fingerprint &&
      existing.classification_prompt_version === MAILBOX_CLASSIFIER_PROMPT_VERSION
    ) {
      return false;
    }

    const result = await this.classifyThreadWithLLM(detail, { force: options?.force });
    if (!result) return false;

    const modelSelection = this.chooseMailboxClassifierModel();
    this.persistThreadClassification(
      threadId,
      result,
      fingerprint,
      modelSelection?.modelKey || null,
      existing?.classification_state || "pending",
      JSON.stringify(result),
    );

    this.refreshThreadProposals({
      id: detail.id,
      subject: detail.subject,
      needsReply: result.needsReply,
      cleanupCandidate: result.cleanupCandidate,
      staleFollowup: result.staleFollowup,
      category: result.category,
    });
    this.upsertPrimaryContact({ ...detail, needsReply: result.needsReply } as unknown as NormalizedThreadInput);
    return true;
  }

  private async classifyMailboxThreadsForAccount(
    accountId: string,
    options?: { includeBackfill?: boolean; limit?: number; force?: boolean },
  ): Promise<MailboxReclassifyResult> {
    const limit = Math.min(Math.max(options?.limit ?? MAILBOX_CLASSIFIER_MAX_BATCH, 1), 200);
    const account = this.db
      .prepare(
        `SELECT id, classification_initial_batch_at
         FROM mailbox_accounts
         WHERE id = ?`,
      )
      .get(accountId) as { id: string; classification_initial_batch_at: number | null } | undefined;
    if (!account) {
      return { accountId, scannedThreads: 0, reclassifiedThreads: 0 };
    }

    const canBackfill = options?.includeBackfill === true || !account.classification_initial_batch_at;
    const includeAll = options?.force === true && options?.includeBackfill === true;
    const rows = includeAll
      ? (this.db
          .prepare(
            `SELECT id
             FROM mailbox_threads
             WHERE account_id = ?
             ORDER BY unread_count DESC, last_message_at DESC
             LIMIT ?`,
          )
          .all(accountId, limit) as Array<{ id: string }>)
      : (this.db
          .prepare(
            `SELECT id
             FROM mailbox_threads
             WHERE account_id = ?
               AND classification_state IN (${(canBackfill ? ["pending", "backfill_pending"] : ["pending"])
                 .map(() => "?")
                 .join(", ")})
             ORDER BY unread_count DESC, last_message_at DESC
             LIMIT ?`,
          )
          .all(accountId, ...(canBackfill ? ["pending", "backfill_pending"] : ["pending"]), limit) as Array<{
          id: string;
        }>);

    let reclassifiedThreads = 0;
    for (const row of rows) {
      const updated = await this.classifyThreadById(row.id, {
        force: options?.force,
      });
      if (updated) reclassifiedThreads += 1;
    }

    if (!account.classification_initial_batch_at && canBackfill) {
      this.db
        .prepare(
          `UPDATE mailbox_accounts
           SET classification_initial_batch_at = COALESCE(classification_initial_batch_at, ?),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), Date.now(), accountId);
    }

    return {
      accountId,
      scannedThreads: rows.length,
      reclassifiedThreads,
    };
  }

  private refreshThreadProposals(thread: Pick<
    NormalizedThreadInput,
    "id" | "subject" | "needsReply" | "cleanupCandidate" | "staleFollowup" | "category"
  >): void {
    this.db
      .prepare(
        `DELETE FROM mailbox_action_proposals
         WHERE thread_id = ?
           AND status = 'suggested'
           AND proposal_type IN ('reply', 'cleanup', 'follow_up', 'schedule')`,
      )
      .run(thread.id);

    if (thread.needsReply) {
      this.upsertProposal({
        threadId: thread.id,
        type: "reply",
        title: `Reply to ${thread.subject}`,
        reasoning: "Latest message appears to require a response.",
      });
    }
    if (thread.cleanupCandidate) {
      this.upsertProposal({
        threadId: thread.id,
        type: "cleanup",
        title: `Clean up ${thread.subject}`,
        reasoning: "Thread looks promotional or low value and is a candidate for archive/trash review.",
      });
    }
    if (thread.staleFollowup) {
      this.upsertProposal({
        threadId: thread.id,
        type: "follow_up",
        title: `Follow up on ${thread.subject}`,
        reasoning: "This thread still needs a reply and has gone stale.",
      });
    }
    if (thread.category === "calendar") {
      this.upsertProposal({
        threadId: thread.id,
        type: "schedule",
        title: `Propose meeting slots for ${thread.subject}`,
        reasoning: "Thread content looks scheduling related.",
      });
    }
  }

  private upsertPrimaryContact(thread: NormalizedThreadInput): void {
    const primary = thread.participants[0];
    if (!primary?.email) return;
    const now = Date.now();
    const company = companyFromEmail(primary.email);
    const learnedFacts = [
      primary.name ? `Name: ${primary.name}` : null,
      company ? `Company: ${company}` : null,
    ].filter((entry): entry is string => Boolean(entry));

    this.db
      .prepare(
        `INSERT INTO mailbox_contacts
          (id, account_id, email, name, company, role, crm_links_json, learned_facts_json, response_tendency, last_interaction_at, open_commitments, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           account_id = excluded.account_id,
           name = COALESCE(excluded.name, mailbox_contacts.name),
           company = COALESCE(excluded.company, mailbox_contacts.company),
           learned_facts_json = excluded.learned_facts_json,
           last_interaction_at = excluded.last_interaction_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        `contact:${primary.email}`,
        thread.accountId,
        primary.email,
        primary.name || null,
        company || null,
        null,
        JSON.stringify([]),
        JSON.stringify(learnedFacts),
        thread.needsReply ? "awaiting_reply" : "fyi",
        thread.lastMessageAt,
        this.getCommitmentsForThread(thread.id).filter((item) => item.state !== "done").length,
        now,
        now,
      );
  }

  private getSummaryForThread(threadId: string): MailboxSummaryCard | null {
    const row = this.db
      .prepare(
        `SELECT
           thread_id,
           summary_text,
           key_asks_json,
           extracted_questions_json,
           suggested_next_action,
           confidence,
           updated_at
         FROM mailbox_summaries
         WHERE thread_id = ?`,
      )
      .get(threadId) as MailboxSummaryRow | undefined;
    if (!row) return null;
    return this.mapSummaryRow(row);
  }

  private getMessagesForThread(threadId: string): MailboxMessage[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           provider_message_id,
           direction,
           from_name,
           from_email,
           to_json,
           cc_json,
           bcc_json,
           subject,
           snippet,
           body_text,
           body_html,
           received_at,
           is_unread
         FROM mailbox_messages
         WHERE thread_id = ?
         ORDER BY received_at ASC`,
      )
      .all(threadId) as MailboxMessageRow[];
    return rows.map((row) => this.mapMessageRow(row));
  }

  private getDraftsForThread(threadId: string): MailboxDraftSuggestion[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           subject,
           body_text,
           tone,
           rationale,
           schedule_notes,
           created_at,
           updated_at
         FROM mailbox_drafts
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as MailboxDraftRow[];
    return rows.map((row) => this.mapDraftRow(row));
  }

  private getProposalsForThread(threadId: string): MailboxActionProposal[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           proposal_type,
           title,
           reasoning,
           preview_json,
           status,
           created_at,
           updated_at
         FROM mailbox_action_proposals
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as MailboxProposalRow[];
    return rows.map((row) => this.mapProposalRow(row));
  }

  private getCommitmentsForThread(threadId: string): MailboxCommitment[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           message_id,
           title,
           due_at,
           state,
           owner_email,
           source_excerpt,
           metadata_json,
           created_at,
           updated_at
         FROM mailbox_commitments
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as MailboxCommitmentRow[];
    return rows.map((row) => this.mapCommitmentRow(row));
  }

  private getPrimaryContactMemory(threadId: string): MailboxContactMemory | null {
    const thread = this.db
      .prepare("SELECT account_id, participants_json FROM mailbox_threads WHERE id = ?")
      .get(threadId) as { account_id: string; participants_json: string | null } | undefined;
    const email = parseJsonArray<MailboxParticipant>(thread?.participants_json).find(Boolean)?.email;
    if (!thread?.account_id || !email) return null;
    const row = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           email,
           name,
           company,
           role,
           crm_links_json,
           learned_facts_json,
           response_tendency,
           last_interaction_at,
           open_commitments
         FROM mailbox_contacts
         WHERE email = ?`,
      )
      .get(email) as MailboxContactRow | undefined;
    if (!row) return null;
    return {
      ...this.mapContactRow(row),
      ...this.getContactInsights(thread.account_id, email),
    };
  }

  private getContactInsights(
    accountId: string,
    email: string,
  ): Pick<
    MailboxContactMemory,
    | "totalThreads"
    | "totalMessages"
    | "averageResponseHours"
    | "lastOutboundAt"
    | "recentSubjects"
    | "styleSignals"
    | "recentOutboundExample"
    | "responseTendency"
  > {
    const like = `%${email}%`;
    const threadRows = this.db
      .prepare(
        `SELECT id, subject, last_message_at
         FROM mailbox_threads
         WHERE account_id = ? AND participants_json LIKE ?
         ORDER BY last_message_at DESC`,
      )
      .all(accountId, like) as Array<{ id: string; subject: string; last_message_at: number }>;

    const messageRows = this.db
      .prepare(
        `SELECT
           m.thread_id,
           m.direction,
           m.body_text,
           m.received_at
         FROM mailbox_messages m
         JOIN mailbox_threads t ON t.id = m.thread_id
         WHERE t.account_id = ? AND t.participants_json LIKE ?
         ORDER BY m.received_at ASC`,
      )
      .all(accountId, like) as Array<{
        thread_id: string;
        direction: "incoming" | "outgoing";
        body_text: string;
        received_at: number;
      }>;

    const outgoingMessages = messageRows
      .filter((row) => row.direction === "outgoing")
      .map((row) => normalizeWhitespace(row.body_text, 600))
      .filter(Boolean);

    const responseSamples: number[] = [];
    const latestIncomingByThread = new Map<string, number>();
    for (const row of messageRows) {
      if (row.direction === "incoming") {
        latestIncomingByThread.set(row.thread_id, row.received_at);
        continue;
      }
      const lastIncoming = latestIncomingByThread.get(row.thread_id);
      if (lastIncoming && row.received_at >= lastIncoming) {
        responseSamples.push((row.received_at - lastIncoming) / (60 * 60 * 1000));
        latestIncomingByThread.delete(row.thread_id);
      }
    }

    const styleProfile = this.buildDraftStyleProfile({
      outgoingMessages,
      averageResponseHours: average(responseSamples),
    });

    return {
      totalThreads: threadRows.length,
      totalMessages: messageRows.length,
      averageResponseHours: styleProfile.averageResponseHours,
      lastOutboundAt: messageRows.filter((row) => row.direction === "outgoing").slice(-1)[0]?.received_at,
      recentSubjects: threadRows.map((row) => row.subject).filter(Boolean).slice(0, 3),
      styleSignals: styleProfile.styleSignals,
      recentOutboundExample: styleProfile.recentOutboundExample,
      responseTendency:
        styleProfile.averageResponseHours && styleProfile.averageResponseHours <= 6
          ? `Usually replies within ${styleProfile.averageResponseHours.toFixed(1)} hours`
          : outgoingMessages.length
            ? `Tone tends ${styleProfile.tone}`
            : undefined,
    };
  }

  private buildDraftStyleProfile(input: {
    outgoingMessages: string[];
    averageResponseHours?: number;
  }): DraftStyleProfile {
    const outgoingMessages = input.outgoingMessages.filter(Boolean);
    const tone = outgoingMessages.length ? classifyTone(outgoingMessages) : "concise";
    const greeting = inferGreeting(outgoingMessages);
    const signoff = inferSignoff(outgoingMessages) || (tone === "warm" ? "Thanks," : "Best,");
    const averageLength = average(outgoingMessages.map((message) => message.length)) || 0;
    const styleSignals = [
      averageLength < 220 ? "Prefers short replies" : averageLength > 500 ? "Often writes with fuller context" : null,
      greeting?.startsWith("Hey") ? "Usually opens casually" : greeting?.startsWith("Hello") ? "Usually opens formally" : null,
      /^thanks/i.test(signoff) ? "Usually signs off with Thanks" : /^best/i.test(signoff) ? "Usually signs off with Best" : null,
      typeof input.averageResponseHours === "number"
        ? `Average response time ${input.averageResponseHours.toFixed(1)}h`
        : null,
    ].filter((entry): entry is string => Boolean(entry));

    return {
      greeting,
      signoff,
      tone,
      averageLength,
      averageResponseHours: input.averageResponseHours,
      styleSignals,
      recentOutboundExample: outgoingMessages.length
        ? normalizeWhitespace(outgoingMessages[outgoingMessages.length - 1], 180)
        : undefined,
    };
  }

  private async getThreadCore(
    threadId: string,
  ): Promise<(MailboxThreadListItem & { messages: MailboxMessage[] }) | null> {
    const row = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           unread_count,
           message_count,
           last_message_at,
           classification_state
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(threadId) as MailboxThreadRow | undefined;
    if (!row) return null;
    return {
      ...this.mapThreadRow(row, this.getSummaryForThread(threadId) || undefined),
      messages: this.getMessagesForThread(threadId),
    };
  }

  private async getScheduleSuggestion(): Promise<ScheduleSuggestion> {
    if (!GoogleWorkspaceSettingsManager.loadSettings().enabled) {
      const now = new Date();
      const options: ScheduleOption[] = [];
      const preferredHours = [11, 15, 10];
      for (let dayOffset = 1; dayOffset <= 5 && options.length < 3; dayOffset++) {
        const date = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
        if (date.getDay() === 0 || date.getDay() === 6) continue;
        const hour = preferredHours[options.length] ?? preferredHours[preferredHours.length - 1];
        date.setHours(hour, 0, 0, 0);
        options.push(buildScheduleOption(date));
      }
      return {
        options,
        summary: "Google Calendar not connected, using lightweight default availability placeholders.",
      };
    }

    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const response = await googleCalendarRequest(settings, {
      method: "GET",
      path: "/calendars/primary/events",
      query: {
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 25,
      },
    });
    const busy = Array.isArray(response.data?.items) ? response.data.items : [];
    const taken = (busy as Array<{ start?: { dateTime?: string } }>)
      .map((item: { start?: { dateTime?: string } }) => asString(item?.start?.dateTime))
      .filter((value: string | null): value is string => Boolean(value))
      .map((value: string) => new Date(value).getHours());

    const preferredHours = [10, 11, 14, 15, 16];
    const options: ScheduleOption[] = [];
    for (let dayOffset = 1; dayOffset <= 5 && options.length < 3; dayOffset++) {
      const date = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      if (date.getDay() === 0 || date.getDay() === 6) continue;
      for (const hour of preferredHours) {
        if (taken.includes(hour)) continue;
        const candidate = new Date(date);
        candidate.setHours(hour, 0, 0, 0);
        options.push(buildScheduleOption(candidate));
        if (options.length >= 3) break;
      }
    }

    return {
      options:
        options.length
          ? options
          : (() => {
              const fallback: ScheduleOption[] = [];
              for (let dayOffset = 1; dayOffset <= 5 && fallback.length < 3; dayOffset++) {
                const date = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
                if (date.getDay() === 0 || date.getDay() === 6) continue;
                date.setHours([11, 15, 10][fallback.length] ?? 11, 0, 0, 0);
                fallback.push(buildScheduleOption(date));
              }
              return fallback;
            })(),
      summary: "Suggested free windows based on the next few days of Google Calendar events.",
    };
  }

  private async applyArchive(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
        body: {
          removeLabelIds: ["INBOX"],
        },
      });
    } else {
      throw new Error("Archive is not supported for the current IMAP adapter.");
    }

    this.db
      .prepare("UPDATE mailbox_threads SET handled = 1, cleanup_candidate = 0, updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  private async applyTrash(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/trash`,
      });
    } else {
      throw new Error("Trash is not supported for the current IMAP adapter.");
    }

    this.db
      .prepare("UPDATE mailbox_threads SET handled = 1, cleanup_candidate = 0, updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  private async applyMarkRead(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
        body: {
          removeLabelIds: ["UNREAD"],
        },
      });
    } else {
      const channel = this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      if (asString(cfg.protocol) === "loom") {
        const loomBaseUrl = asString(cfg.loomBaseUrl);
        const accessToken = asString(cfg.loomAccessToken);
        const identity = asString(cfg.loomIdentity) || loomBaseUrl;
        if (!loomBaseUrl || !accessToken || !identity) {
          throw new Error("LOOM email channel is missing mailbox credentials.");
        }
        const mailbox = asString(cfg.loomMailboxFolder) || "INBOX";
        const client = new LoomEmailClient({
          baseUrl: loomBaseUrl,
          accessTokenProvider: () => accessToken,
          identity,
          folder: assertSafeLoomMailboxFolder(mailbox),
          pollInterval: asNumber(cfg.loomPollInterval) ?? 30000,
          verbose: process.env.NODE_ENV === "development",
        });
        const latest = thread.messages.filter((message) => message.unread).slice(-1)[0];
        const uid = Number(latest?.providerMessageId);
        if (!Number.isFinite(uid)) {
          throw new Error("Unable to resolve LOOM UID for mark_read");
        }
        await client.markAsRead(uid);
      } else {
        const client = new EmailClient({
          imapHost: asString(cfg.imapHost) || "",
          imapPort: asNumber(cfg.imapPort) ?? 993,
          imapSecure: asBoolean(cfg.imapSecure) ?? true,
          smtpHost: asString(cfg.smtpHost) || "",
          smtpPort: asNumber(cfg.smtpPort) ?? 587,
          smtpSecure: asBoolean(cfg.smtpSecure) ?? false,
          email: asString(cfg.email) || "",
          password: asString(cfg.password) || "",
          displayName: asString(cfg.displayName) || undefined,
          mailbox: asString(cfg.mailbox) || "INBOX",
          pollInterval: 30000,
          verbose: process.env.NODE_ENV === "development",
        });
        const latest = thread.messages.filter((message) => message.unread).slice(-1)[0];
        const uid = Number(latest?.providerMessageId);
        if (!Number.isFinite(uid)) {
          throw new Error("Unable to resolve IMAP UID for mark_read");
        }
        await client.markAsRead(uid);
      }
    }

    this.db.prepare("UPDATE mailbox_messages SET is_unread = 0 WHERE thread_id = ?").run(thread.id);
    this.db
      .prepare("UPDATE mailbox_threads SET unread_count = 0, handled = CASE WHEN needs_reply = 0 THEN 1 ELSE handled END, updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  private async applyLabel(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    label: string,
  ): Promise<void> {
    if (thread.provider !== "gmail") {
      throw new Error("Label actions are only supported for Gmail-backed threads.");
    }
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    await gmailRequest(settings, {
      method: "POST",
      path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
      body: {
        addLabelIds: [label],
      },
    });

    const labels = Array.from(new Set([...thread.labels, label]));
    this.db
      .prepare("UPDATE mailbox_threads SET labels_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(labels), Date.now(), thread.id);
  }

  private async applySendDraft(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    draftId?: string,
  ): Promise<void> {
    const drafts = this.getDraftsForThread(thread.id);
    const draft = draftId ? drafts.find((entry) => entry.id === draftId) : drafts[0];
    if (!draft) throw new Error("Draft not found");

    const recipient = thread.participants[0]?.email;
    if (!recipient) throw new Error("No recipient found for draft");

    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      const raw = Buffer.from(
        [
          `To: ${recipient}`,
          `Subject: ${draft.subject}`,
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset="UTF-8"',
          "",
          draft.body,
        ].join("\r\n"),
      )
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/messages/send",
        body: {
          raw,
          threadId: thread.providerThreadId,
        },
      });
    } else {
      const channel = this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      const client = new EmailClient({
        imapHost: asString(cfg.imapHost) || "",
        imapPort: asNumber(cfg.imapPort) ?? 993,
        imapSecure: asBoolean(cfg.imapSecure) ?? true,
        smtpHost: asString(cfg.smtpHost) || "",
        smtpPort: asNumber(cfg.smtpPort) ?? 587,
        smtpSecure: asBoolean(cfg.smtpSecure) ?? false,
        email: asString(cfg.email) || "",
        password: asString(cfg.password) || "",
        displayName: asString(cfg.displayName) || undefined,
        mailbox: asString(cfg.mailbox) || "INBOX",
        pollInterval: 30000,
        verbose: process.env.NODE_ENV === "development",
      });
      await client.sendEmail({
        to: recipient,
        subject: draft.subject,
        text: draft.body,
      });
    }

    this.updateProposalStatusByThreadAndType(thread.id, "reply", "applied");
  }

  private async applyDiscardDraft(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    draftId?: string,
  ): Promise<void> {
    const drafts = this.getDraftsForThread(thread.id);
    const draft = draftId ? drafts.find((entry) => entry.id === draftId) : drafts[0];
    if (!draft) throw new Error("Draft not found");

    this.db
      .prepare("DELETE FROM mailbox_drafts WHERE id = ?")
      .run(draft.id);

    this.updateProposalStatusByThreadAndType(thread.id, "reply", "dismissed");
  }

  private async applyScheduleEvent(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    proposalId?: string,
  ): Promise<void> {
    if (!GoogleWorkspaceSettingsManager.loadSettings().enabled) {
      throw new Error("Google Calendar must be connected before creating schedule events.");
    }
    const proposal =
      proposalId
        ? this.getProposalsForThread(thread.id).find((entry) => entry.id === proposalId)
        : undefined;
    const previewOptions = Array.isArray(proposal?.preview?.slotOptions)
      ? proposal.preview.slotOptions
          .map((value) => {
            const record = asObject(value);
            const label = asString(record?.label);
            const start = asString(record?.start);
            const end = asString(record?.end);
            if (!label || !start || !end) return null;
            return { label, start, end } satisfies ScheduleOption;
          })
          .filter((value): value is ScheduleOption => Boolean(value))
      : [];
    const selectedOption = previewOptions[0] || (await this.getScheduleSuggestion()).options[0];
    if (!selectedOption) {
      throw new Error("No schedule slot is available");
    }

    await googleCalendarRequest(GoogleWorkspaceSettingsManager.loadSettings(), {
      method: "POST",
      path: "/calendars/primary/events",
      body: {
        summary: thread.subject,
        description: `Scheduled from Inbox Agent. Suggested slot: ${selectedOption.label}`,
        start: { dateTime: selectedOption.start },
        end: { dateTime: selectedOption.end },
        attendees: thread.participants.slice(0, 1).map((participant) => ({ email: participant.email })),
      },
    });

    this.updateProposalStatusByThreadAndType(thread.id, "schedule", "applied");
  }

  private updateProposalStatus(proposalId: string, status: MailboxProposalStatus): void {
    this.db
      .prepare(
        `UPDATE mailbox_action_proposals
         SET status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, Date.now(), proposalId);
  }

  private updateProposalStatusByThreadAndType(
    threadId: string,
    type: MailboxProposalType,
    status: MailboxProposalStatus,
  ): void {
    this.db
      .prepare(
        `UPDATE mailbox_action_proposals
         SET status = ?, updated_at = ?
         WHERE thread_id = ? AND proposal_type = ?`,
      )
      .run(status, Date.now(), threadId, type);
  }

  private threadIdFromProposal(proposalId?: string): string | undefined {
    if (!proposalId) return undefined;
    const row = this.db
      .prepare("SELECT thread_id FROM mailbox_action_proposals WHERE id = ?")
      .get(proposalId) as { thread_id: string } | undefined;
    return row?.thread_id;
  }

  private updateContactOpenCommitments(threadId: string): void {
    const contact = this.getPrimaryContactMemory(threadId);
    if (!contact) return;
    const openCount = this.getCommitmentsForThread(threadId).filter((item) =>
      item.state === "suggested" || item.state === "accepted",
    ).length;
    this.db
      .prepare(
        `UPDATE mailbox_contacts
         SET open_commitments = ?, updated_at = ?
         WHERE email = ?`,
      )
      .run(openCount, Date.now(), contact.email);
  }

  private upsertProposal(input: {
    threadId: string;
    type: MailboxProposalType;
    title: string;
    reasoning: string;
    preview?: Record<string, unknown>;
  }): void {
    const existing = this.db
      .prepare(
        `SELECT id
         FROM mailbox_action_proposals
         WHERE thread_id = ? AND proposal_type = ? AND status = 'suggested'
         LIMIT 1`,
      )
      .get(input.threadId, input.type) as { id: string } | undefined;
    const now = Date.now();
    if (existing?.id) {
      this.db
        .prepare(
          `UPDATE mailbox_action_proposals
           SET title = ?, reasoning = ?, preview_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.title,
          input.reasoning,
          input.preview ? JSON.stringify(input.preview) : null,
          now,
          existing.id,
        );
      return;
    }

    this.db
      .prepare(
        `INSERT INTO mailbox_action_proposals
          (id, thread_id, proposal_type, title, reasoning, preview_json, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.threadId,
        input.type,
        input.title,
        input.reasoning,
        input.preview ? JSON.stringify(input.preview) : null,
        "suggested",
        JSON.stringify({ source: "mailbox-service" }),
        now,
        now,
      );
  }

  private hasEmailChannel(): boolean {
    const channel = this.channelRepo.findByType("email");
    return Boolean(channel?.enabled);
  }

  private mapAccountRow(row: MailboxAccountRow): MailboxAccount {
    return {
      id: row.id,
      provider: row.provider,
      address: row.address,
      displayName: row.display_name || undefined,
      status: row.status,
      capabilities: parseJsonArray<string>(row.capabilities_json),
      lastSyncedAt: row.last_synced_at || undefined,
      classificationInitialBatchAt: row.classification_initial_batch_at || undefined,
    };
  }

  private mapThreadRow(row: MailboxThreadRow, summary?: MailboxSummaryCard | null): MailboxThreadListItem {
    return {
      id: row.id,
      accountId: row.account_id,
      provider: row.provider,
      providerThreadId: row.provider_thread_id,
      subject: row.subject,
      snippet: row.snippet,
      participants: parseJsonArray<MailboxParticipant>(row.participants_json),
      labels: parseJsonArray<string>(row.labels_json),
      category: row.category,
      priorityBand: priorityBandFromScore(row.priority_score),
      priorityScore: row.priority_score,
      urgencyScore: row.urgency_score,
      needsReply: Boolean(row.needs_reply),
      staleFollowup: Boolean(row.stale_followup),
      cleanupCandidate: Boolean(row.cleanup_candidate),
      handled: Boolean(row.handled),
      unreadCount: row.unread_count,
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
      summary: summary ?? undefined,
      classificationState: row.classification_state,
    };
  }

  private mapMessageRow(row: MailboxMessageRow): MailboxMessage {
    return {
      id: row.id,
      threadId: row.thread_id,
      providerMessageId: row.provider_message_id,
      direction: row.direction,
      from: row.from_email
        ? {
            email: row.from_email,
            name: row.from_name || undefined,
          }
        : undefined,
      to: parseJsonArray<MailboxParticipant>(row.to_json),
      cc: parseJsonArray<MailboxParticipant>(row.cc_json),
      bcc: parseJsonArray<MailboxParticipant>(row.bcc_json),
      subject: row.subject,
      snippet: row.snippet,
      body: row.body_text,
      bodyHtml: row.body_html || undefined,
      receivedAt: row.received_at,
      unread: Boolean(row.is_unread),
    };
  }

  private mapSummaryRow(row: MailboxSummaryRow): MailboxSummaryCard {
    return {
      summary: row.summary_text,
      keyAsks: parseJsonArray<string>(row.key_asks_json),
      extractedQuestions: parseJsonArray<string>(row.extracted_questions_json),
      suggestedNextAction: row.suggested_next_action,
      confidence: row.confidence,
      updatedAt: row.updated_at,
    };
  }

  private mapDraftRow(row: MailboxDraftRow): MailboxDraftSuggestion {
    return {
      id: row.id,
      threadId: row.thread_id,
      subject: row.subject,
      body: row.body_text,
      tone: row.tone,
      rationale: row.rationale,
      scheduleNotes: row.schedule_notes || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapProposalRow(row: MailboxProposalRow): MailboxActionProposal {
    return {
      id: row.id,
      threadId: row.thread_id,
      type: row.proposal_type,
      title: row.title,
      reasoning: row.reasoning,
      preview: row.preview_json ? (JSON.parse(row.preview_json) as Record<string, unknown>) : undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapCommitmentRow(row: MailboxCommitmentRow): MailboxCommitment {
    const metadata = parseCommitmentMetadata(row.metadata_json);
    return {
      id: row.id,
      threadId: row.thread_id,
      messageId: row.message_id || undefined,
      title: row.title,
      dueAt: row.due_at || undefined,
      state: row.state,
      ownerEmail: row.owner_email || undefined,
      sourceExcerpt: row.source_excerpt || undefined,
      followUpTaskId: metadata.followUpTaskId,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private ensureFollowUpTaskForCommitment(
    row: MailboxCommitmentRow,
    metadata: MailboxCommitmentMetadata,
  ): Task | null {
    if (metadata.followUpTaskId) {
      const existing = this.taskRepo.findById(metadata.followUpTaskId);
      if (existing) return existing;
    }

    const thread = this.db
      .prepare(
        `SELECT id, subject, participants_json
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(row.thread_id) as { id: string; subject: string; participants_json: string | null } | undefined;
    const workspaceId = this.resolveFollowUpWorkspaceId();
    if (!workspaceId) {
      throw new Error("No workspace available to create a follow-up task");
    }

    const recipient = parseJsonArray<MailboxParticipant>(thread?.participants_json)[0]?.email;
    const title = `Follow up: ${normalizeWhitespace(row.title, 90) || "email commitment"}`;
    const promptParts = [
      `Follow up on this email commitment.`,
      `Commitment: ${row.title}`,
      thread?.subject ? `Thread subject: ${thread.subject}` : null,
      row.due_at ? `Due date: ${new Date(row.due_at).toISOString()}` : null,
      recipient ? `Primary contact: ${recipient}` : null,
      row.source_excerpt ? `Source excerpt: ${row.source_excerpt}` : null,
      "Track this as a real follow-up item and close it when the commitment is complete.",
    ].filter((part): part is string => Boolean(part));

    const task = this.taskRepo.create({
      title,
      prompt: promptParts.join("\n"),
      rawPrompt: promptParts.join("\n"),
      userPrompt: promptParts.join("\n"),
      status: "pending",
      workspaceId,
      source: "manual",
    });

    this.db
      .prepare(
        `UPDATE mailbox_commitments
         SET metadata_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          ...metadata,
          followUpTaskId: task.id,
          followUpTaskCreatedAt: Date.now(),
          followUpTaskWorkspaceId: workspaceId,
        }),
        Date.now(),
        row.id,
      );

    return task;
  }

  private resolveFollowUpWorkspaceId(): string | null {
    const workspaces = this.workspaceRepo.findAll();
    const preferred = workspaces.find(
      (workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id),
    );
    return (preferred ?? workspaces[0])?.id ?? null;
  }

  private mapContactRow(row: MailboxContactRow): MailboxContactMemory {
    return {
      id: row.id,
      accountId: row.account_id,
      email: row.email,
      name: row.name || undefined,
      company: row.company || undefined,
      role: row.role || undefined,
      crmLinks: parseJsonArray<string>(row.crm_links_json),
      learnedFacts: parseJsonArray<string>(row.learned_facts_json),
      responseTendency: row.response_tendency || undefined,
      lastInteractionAt: row.last_interaction_at || undefined,
      openCommitments: row.open_commitments || 0,
    };
  }
}

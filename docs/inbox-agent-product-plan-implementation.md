# Inbox Agent Product Plan — Implementation Spec

This document satisfies the product-planning deliverables: Phase 1 UX requirements, cross-system signal mapping, chosen first implementation slice, and success metrics. It complements [inbox-agent.md](inbox-agent.md) and the roadmap plan (do not edit the plan file in `.cursor/plans/`).

## 1. Phase 1 UX Requirements

### AI auto-labels and saved views

- **Create flow**: User provides a **name** and **natural-language instructions** (what should belong in this view). Optional: seed from the **currently open thread**.
- **Preview**: Before saving, show a **sample of matching threads** (ranked) with checkmarks to include/exclude; user confirms **Save view**.
- **Persistence**: Saved views are workspace-scoped, stored locally, and appear as **filters** alongside existing category chips.
- **Inbox behavior**: `show_in_inbox` (default on) means matching threads remain in the main inbox list; when off, matching threads are **only** visible when the saved view is selected (implemented as filter + optional `local_inbox_hidden` in a later iteration).

### Label similar (example-based)

- **Entry**: Button on thread detail: **“Find similar & save view”**.
- **Behavior**: Uses the open thread’s subject, snippet, and summary (if any) plus user instructions to find **similar threads** in the cached mailbox via an LLM-ranked candidate set.
- **Output**: Same preview/confirm flow as auto-labels, then persists memberships for the new view.

### Quick reply chips

- **When**: After a thread has enough context (summary or last message), show **up to three** short reply suggestions.
- **Constraints**: No suggestions for no-reply senders (same policy as draft generation). User taps a chip to **fill the reply composer** (does not send automatically).

### Snippets / templates

- **Storage**: Per-workspace snippets with **shortcut label** and **body** (optional subject hint for future send flows).
- **UX**: Snippet picker near the reply area; choosing one **inserts** text into the composer.

### Learning feedback (lightweight)

- **Events**: On **reclassify**, **archive**, **trash**, **mark read**, and **dismiss proposal**, record an optional **feedback row** (thread id, kind, timestamp) for future classifier and ranking improvements.
- **Privacy**: Stored locally only; no new cloud sync.

### Onboarding loop (later Phase 1 polish)

- Short questionnaire: priorities, domains to deprioritize, VIP senders — used to **seed** saved views and automations. Not required for the first code slice.

## 2. Cross-System Hooks (CoWork OS)

| Signal | Mission Control | Automations / triggers | Heartbeat | Briefing | Knowledge Graph | Memory / playbooks |
|--------|-----------------|-------------------------|-----------|----------|-----------------|--------------------|
| Saved view created / thread matched | Optional handoff from high-priority view | Rule or schedule **bridge** from saved view | Pulse can use view membership as context in future | Mention “N saved views active” in mailbox section | Entity extraction from threads in view | Playbook capture for repeated triage patterns |
| Triage feedback | Issue updates if linked | Refine trigger conditions over time | Lower noise if user consistently dismisses class | — | Reinforce entity confidence | Reinforcement signals |
| Quick reply / snippet usage | — | — | — | Usage counts in productivity metrics | — | Style / template preferences |

Mailbox events (`thread_classified`, `mission_control_handoff_created`, etc.) continue to flow through [MailboxAutomationHub](../electron/mailbox/MailboxAutomationHub.ts) as today.

## 3. First Implementation Slice (chosen)

Smallest set that improves **perception** and **differentiation** without rewriting the mailbox:

1. **Saved views** — DB + list/filter + create from “label similar” preview.
2. **Quick reply suggestions** — LLM-backed chips in thread detail.
3. **Snippets** — CRUD + insert into reply.
4. **Triage feedback** — Record rows on key actions (foundation for learning).
5. **Mission Control back-link** — Handoff records in thread detail with **Open in Mission Control** (company + issue).
6. **Saved view → automation bridge** — Create a **scheduled review** task for the view (reminder patrol) using existing mailbox schedule APIs.

## 4. Success Metrics

| Metric | Definition | Target direction |
|--------|------------|------------------|
| Time to triage | Median seconds from open thread to archive/mark-read or reply | Decrease |
| Saved view usage | % of active users with ≥1 saved view; filters used per session | Increase |
| Quick reply adoption | Chips clicked / threads with suggestions shown | Increase |
| Snippet usage | Inserts per week | Increase |
| Handoff traceability | % of MC handoffs opened from inbox vs created-only | Increase |
| Automation bridge | Schedules created from saved views | Increase (secondary) |
| Feedback volume | Triage feedback rows per user (opt-in analytics locally) | Increase slowly (signal quality) |

---

## Code references

- UI: [InboxAgentPanel.tsx](../src/renderer/components/InboxAgentPanel.tsx)
- Service: [MailboxService.ts](../src/electron/mailbox/MailboxService.ts)
- Types: [mailbox.ts](../src/shared/mailbox.ts)
- Mission Control: [useMissionControlData.ts](../src/renderer/components/mission-control/useMissionControlData.ts)

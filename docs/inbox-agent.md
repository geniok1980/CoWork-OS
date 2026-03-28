# Inbox Agent

Inbox Agent turns email into an action workspace instead of a long scroll of threads. It sits on top of local mailbox sync, keeps the inbox view available from the database on restart, and layers AI-assisted triage, drafting, follow-up tracking, and commitment handling on top.

## What It Does

Inbox Agent helps you move from "read everything" to "act on the few items that matter":

- classify threads into `Unread`, `Action Needed`, `Suggested Actions`, and `Open Commitments`
- keep `Inbox`, `Sent`, and `All` views separate so outbound mail does not clutter the inbox
- sort by `Recent` or `Priority`
- surface cleanup, follow-up, drafting, scheduling, and intelligence-refresh actions
- convert emails into draft replies, todos, and trackable follow-up commitments
- keep synced mail visible locally so a restart does not blank the inbox

## Why It Is Useful

The main advantage of Inbox Agent is speed without losing context:

- **Less manual triage** - important threads are surfaced directly instead of forcing you to scan the full mailbox
- **Fewer missed replies** - action-needed mail is separated from newsletters and system notifications
- **Clear next steps** - every thread can move toward a draft, a task, a commitment, or dismissal
- **Local-first persistence** - inbox state is stored in the local database and survives app restarts
- **Actionable commitments** - accepted commitments can become real follow-up tasks instead of staying as a label
- **Safer review flow** - drafts can be sent or discarded, so generated output is always reviewable before it becomes an external action

## Core Surfaces

| Surface | What It Does |
|---------|--------------|
| Metric cards | Show unread mail, action-needed mail, suggested actions, and open commitments at a glance. |
| View filters | Switch between `Inbox`, `Sent`, and `All`. |
| Sort controls | Toggle between `Recent` and `Priority`. |
| Thread list | Browse the mailbox with live filter and sort updates. |
| Thread detail | Inspect the full conversation, summary, drafts, and commitments for a selected thread. |
| Agent rail | Run cleanup, follow-up, preparation, todo extraction, scheduling, and intel refresh actions. |

## Typical Workflow

1. Open Inbox Agent and let it load the cached mailbox from the local database.
2. Review the metric cards to decide whether to focus on unread, action-needed, suggested actions, or commitments.
3. Switch between `Inbox`, `Sent`, and `All` if you want to isolate received mail from outbound mail.
4. Sort by `Recent` when you want the newest messages first, or `Priority` when you want the highest-signal threads first.
5. Open a thread and use `Prep thread` to generate a concise summary, extract commitments, and draft a response.
6. Send the draft, discard it, or turn commitments into follow-up tasks.
7. Use `Refresh intel` when a thread changed and you want the summary, commitment extraction, and contact signals refreshed together.

## Actions In Practice

- **Cleanup** - suggests low-value mail that can be archived or handled in bulk
- **Follow-up** - surfaces stale threads that still need a response
- **Prep thread** - prepares the thread for action by summarizing it and drafting a reply
- **Extract todos** - finds commitments and turns them into trackable follow-up items
- **Schedule** - proposes or creates calendar time for the thread when a meeting is needed
- **Refresh intel** - re-runs the thread analysis and contact intelligence for the selected conversation

## Notes

- `Unread` remains provider-backed and deterministic.
- `Action Needed`, `Suggested Actions`, and `Open Commitments` are AI-assisted surfaces.
- Sending, archiving, trashing, marking read, and scheduling are still gated by the connected mailbox/calendar provider.
- The inbox can re-sync in the background while still showing cached mail immediately.

For a higher-level overview of the product surface, see [Features](features.md). For test prompts that exercise inbox workflows, see [Use Cases](use-cases.md).

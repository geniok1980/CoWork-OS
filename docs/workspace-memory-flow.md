# Workspace Memory Flow

This document describes how CoWork OS stores, curates, retrieves, and injects workspace memory after the layered-memory upgrade.

The foundation is still the hybrid memory system, but the runtime now makes it explicit as a four-layer wake-up model built on top of those storage lanes:

- **Curated hot memory**: small, prompt-visible, explicitly edited or promoted
- **Recall archive**: larger searchable memory/history, not injected by default
- **Session recall**: recent transcript/checkpoint history for “what happened in that run?”
- **Topic packs**: focused `.cowork/memory/topics/*.md` files loaded explicitly for topical work

Those lanes map into runtime layers as:

- **L0 Identity**: curated user/workspace memory + `USER.md` essentials
- **L1 Essential Story**: durable decisions, weekly/daily synthesis, active commitments
- **L2 Topic Packs**: focused topic files loaded on demand
- **L3 Deep Recall**: unified recall and verbatim quote search across tasks/messages/files/memory/KG

---

## Overview

```text
User messages / task events / accepted distill candidates
        │
        ├─→ CuratedMemoryService
        │     ├─→ curated_memory_entries (SQLite)
        │     ├─→ .cowork/USER.md (auto block)
        │     └─→ .cowork/MEMORY.md (auto block)
        │
        ├─→ MemoryService
        │     └─→ memories + embeddings + summaries (archive lane)
        │
        ├─→ TranscriptStore
        │     └─→ .cowork/memory/transcripts/*
        │
        └─→ DailyLogService / DailyLogSummarizer
              └─→ .cowork/memory/daily + summaries

MemorySynthesizer.synthesize()
        │
        ├─→ L0 Identity
        │     ├─→ workspace kit essentials
        │     └─→ hot curated memory
        └─→ L1 Essential Story
              └─→ playbook / KG / daily summaries

Explicit recall tools
        ├─→ search_memories
        ├─→ search_sessions
        ├─→ search_quotes
        ├─→ memory_topics_load
        ├─→ memory_curate
        └─→ memory_curated_read
```

---

## Lane 1 — Curated Hot Memory

**Service:** `src/electron/memory/CuratedMemoryService.ts`  
**Storage:** `curated_memory_entries` table  
**Mirrors:** `.cowork/USER.md`, `.cowork/MEMORY.md`

This lane is for the small set of durable facts that should stay front-and-center in prompts:

- user preferences
- identity facts
- durable constraints
- workflow rules
- project facts
- active commitments

### How entries arrive

- explicit agent/user actions through `memory_curate`
- accepted stable promotions from `CoreMemoryDistiller`
- future human edits that are synced back through governed workflows

### Guardrails

- curated content is normalized before storage
- stored curated content is capped at **320 characters**
- `match` strings used for replace/remove are capped at **120 characters**
- writes mirror into auto-managed blocks inside `.cowork/USER.md` and `.cowork/MEMORY.md`
- file sync is serialized per workspace to reduce last-writer-wins races
- replace/remove prefers stable `id` values from `memory_curated_read` for deterministic updates

### Prompt behavior

Curated hot memory is injected by default through `<cowork_hot_memory>`.

---

## Lane 2 — Recall Archive

**Service:** `src/electron/memory/MemoryService.ts`  
**Storage:** `memories`, `memory_embeddings`, `memory_summaries`

This is the broad searchable archive:

- observations
- decisions
- errors
- insights
- imported ChatGPT history
- compressed summaries

This lane still uses hybrid lexical + local semantic retrieval, but it is **not injected by default**. The feature flag `defaultArchiveInjectionEnabled` now defaults to `false`.

### Retrieval path

- `search_memories` searches archive memory plus indexed `.cowork/` markdown
- archive recall can still be injected when explicitly enabled for a workspace/runtime
- `MemoryTierService` still tracks reference counts and promotes/evicts archive entries over time

---

## Lane 3 — Session Recall

**Service:** `src/electron/memory/SessionRecallService.ts`  
**Backing store:** `src/electron/memory/TranscriptStore.ts`

Recent task/session history is now a first-class recall lane rather than something folded into archive recall.

Stored artifacts include:

- transcript spans under `.cowork/memory/transcripts/spans/*.jsonl`
- lightweight checkpoints under `.cowork/memory/transcripts/checkpoints/*.json`

Each checkpoint can now carry two complementary artifacts:

- `structuredSummary`: compact durable synthesis used by existing memory/prompt flows
- `evidencePacket`: exact transcript/message spans with provenance and a dedupe hash

### Checkpoint capture triggers

- **Pre-compaction**: always, before messages are dropped
- **Periodic long-run capture**: every 12 meaningful user/assistant exchanges, deduped by span hash
- **Task completion**: only when the task produced a non-trivial result or decision

### Retrieval path

- `search_sessions` searches transcript spans
- optional checkpoint search can widen recall to summary/checkpoint payloads
- this is intended for “what happened in that run?” rather than “what should the system remember forever?”

### Verbatim recall lane

`search_quotes` is the low-loss recall lane for exact wording. It searches:

- transcript spans
- task messages
- imported/archive memories
- indexed workspace markdown

Results return exact excerpts plus provenance such as `sourceType`, `objectId`, `taskId`, `timestamp`, optional `path`, and ranking reason. Transcript/message hits outrank synthesized-memory hits when both match.

---

## Topic Packs

**Service:** `src/electron/memory/LayeredMemoryIndexService.ts`  
**Files:** `.cowork/memory/MEMORY.md`, `.cowork/memory/topics/*.md`

Topic packs are query-scoped, focused memory slices generated from:

- relevant archive recall
- relevant indexed markdown
- curated hot memory summary lines
- recent daily summaries

### Retrieval path

- `memory_topics_load` can rebuild topic files for a query
- `memory_topics_load(refresh: false)` now performs a true read-only lookup over existing topic files
- topic snippets are intentionally capped so packs stay compact

Topic packs are for topical work such as “bring me the onboarding context for billing migrations,” not for always-on prompt injection.

---

## Daily Logs and Summaries

### Operational Daily Log

**Service:** `src/electron/memory/DailyLogService.ts`  
**Location:** `.cowork/memory/daily/<YYYY-MM-DD>.md`

When another runtime path or automation writes entries through `DailyLogService`, the files act as raw operational journals for:

- user feedback events
- task completions
- notable decisions
- high-value observations or corrections

Raw daily logs are never injected into prompts.

### Daily Summaries

**Service:** `src/electron/memory/DailyLogSummarizer.ts`  
**Location:** `.cowork/memory/summaries/<YYYY-MM-DD>.md`

Daily summaries remain part of the structured memory lane. They are ranked below curated/user relationship facts and above raw archive snippets when archive injection is enabled.

---

## Prompt Synthesis

**Service:** `src/electron/memory/MemorySynthesizer.ts`

Prompt synthesis now builds separate sections instead of one monolithic synthesized-memory block:

- `<cowork_hot_memory>` — `L0 Identity`: curated hot memory + user/profile + active relationship items
- `<cowork_structured_memory>` — `L1 Essential Story`: playbook, daily summaries, active commitments, and current KG context

`L2 Topic Packs` and `L3 Deep Recall` are not injected into the live prompt by default. They stay explicit and tool-driven.

Workspace kit context is still injected separately and placed before the memory sections.

### Budgeting

- total memory synthesis budget defaults to `2800` estimated tokens
- workspace kit keeps roughly `35%` of the budget
- remaining budget is split between hot memory and structured memory
- fragment selection happens before rendering, so truncation does not cut markup blocks mid-stream

### Default injection behavior

- `L0 Identity`: **on**
- `L1 Essential Story`: **on**
- archive memory: **off by default**
- `L2 Topic Packs`: **tool-driven**
- `L3 Deep Recall` (`search_quotes`, `search_sessions`, `search_memories`): **tool-driven**

---

## Workspace Kit Context

**Service:** `src/electron/memory/WorkspaceKitContext.ts`  
**Location:** `.cowork/*.md`

The workspace kit remains a governed durable context layer with its own contracts, freshness windows, and prompt budgets. `USER.md` and `MEMORY.md` now contain auto-managed curated-memory blocks in addition to human-authored content.

From **Settings → Memory Hub → Per Workspace**, the "Open USER.md" and "Open MEMORY.md" buttons open (or create if missing) these files directly in the system editor via `kit:openFile` IPC.

Memory Hub also shows a preview of the current `L0/L1` payload plus the `L2/L3` layers excluded from default injection, including fragment counts dropped by budget.

---

## Message Feedback → Memory

User feedback still flows into memory/personalization systems:

```text
User clicks 👍 or 👎 (+ optional reason)
        │
        ▼
kit:submitMessageFeedback IPC
        │
        ▼
UserProfileService.ingestUserFeedback()
        │
        ├─→ RelationshipMemoryService
        └─→ AdaptiveStyleEngine.observeFeedback()  [if enabled]
```

Feedback reason values: `incorrect`, `too_verbose`, `ignored_instructions`, `wrong_tone`, `unsafe`.

---

## Related docs

- [Evolving Agent Intelligence](evolving-agent-intelligence.md)
- [Execution Runtime Model](execution-runtime-model.md)
- [Features](features.md)
- [Integration Setup, Skill Proposals, and Bootstrap Lifecycle](integration-skill-bootstrap-lifecycle.md)

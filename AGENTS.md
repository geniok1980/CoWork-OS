# AGENTS.md

## Failure Triage

When a user reports a failure, error, or unexpected behavior:

1. Check development logs first, if available.
2. Read `logs/dev-latest.log` for the most recent captured run.
3. If `logs/dev-latest.log` is missing or stale for the current repro, run `npm run dev:log` to capture a fresh run.
4. If needed, inspect the newest timestamped file in `logs/dev-*.log` for full context.
5. Quote relevant error lines with timestamps when summarizing findings.
6. If logs are missing, state that clearly and continue with other diagnostics.

## Dev Log Availability

- Log capture is controlled by **Settings -> Appearance -> Developer logging** (default off).
- A forced capture run can be started with `npm run dev:log`.
- Optional local toggle state may exist at `.cowork/dev-log-settings.json`.

## Dev Startup Commands

- Use `npm run dev` for normal development startup; it routes through the log-aware wrapper.
- Use `npm run dev:start` only when you explicitly need the raw underlying startup command.
- `npm run dev:start` auto-selects an available localhost dev-server port (starting from `COWORK_DEV_SERVER_PORT`, default `5173`) and exports `COWORK_DEV_SERVER_URL` for Electron startup.
- Use `npm run dev:log` to force timestamped capture to `logs/dev-*.log` and `logs/dev-latest.log`.
- Use `npm run dev:electron` (or the wrappers that call it) when starting Electron manually; it clears `ELECTRON_RUN_AS_NODE` to avoid renderer env pollution.
- Avoid using `npm run dev:react` alone for desktop debugging; it skips Electron preload APIs and can produce misleading behavior.

## Build Workflow

- `npm run build` now includes `npm run build:healthkit-bridge` before Electron/daemon/connectors builds.
- Use `npm run build:healthkit-bridge` to isolate HealthKit bridge build failures.
- `npm run build:healthkit-bridge` is a no-op on non-macOS platforms (`[healthkit-bridge] Skipping build on non-macOS platform.`).
- On macOS, `npm run build:healthkit-bridge` attempts an Xcode app build first and falls back to SwiftPM packaging if the app bundle is not produced.
- For macOS signing/provisioning overrides during `build:healthkit-bridge`, use `COWORK_HEALTHKIT_DEVELOPMENT_TEAM` and `COWORK_HEALTHKIT_PROVISIONING_PROFILE` if needed.
- `build:healthkit-bridge` also accepts `DEVELOPMENT_TEAM` and `HEALTHKIT_BRIDGE_PROVISIONING_PROFILE` as fallback environment variable names.

## QA and Reliability Commands

- Use `npm run skills:check` before test/merge when touching bundled skills; it runs routing/content/audit/eval quality gates.
- Use `npm run qa:eval:run` to replay the eval suite, and `npm run qa:reliability` for the combined eval + battery loop.
- Use `npm run qa:timeline:backfill -- --db /absolute/path/to.db` then `npm run qa:timeline:enforce -- --db /absolute/path/to.db` when validating timeline completion telemetry changes.

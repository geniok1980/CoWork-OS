# Trust Boundaries

Understanding the security boundaries in CoWork OS helps you configure appropriate access controls.

## Workspace Boundary

```
+------------------------------------------+
|              Workspace                    |
|  +------------------------------------+  |
|  |     Files & Directories            |  |
|  |  - Source code                     |  |
|  |  - Configuration                   |  |
|  |  - Generated artifacts             |  |
|  +------------------------------------+  |
|                                          |
|  Permissions:                            |
|  - read, write, delete                   |
|  - shell (command execution)             |
|  - network (browser/web access)          |
+------------------------------------------+
         |
         | Allowed Paths (optional)
         v
+------------------------------------------+
|           External Paths                  |
|  - ~/Documents (if configured)           |
|  - /shared/projects (if configured)      |
+------------------------------------------+
```

### Workspace Isolation

Each workspace operates in isolation:
- Tools can only access files within the workspace by default
- External paths require explicit configuration
- Different workspaces cannot access each other's files

### Unrestricted Mode

When `unrestrictedFileAccess` is enabled:
- Tools can read/write files anywhere the user has permission
- Protected system paths are still blocked
- Use only for development workflows requiring broad access

## Imported Capability Boundary

```
+------------------------------------------+
|      Remote / Imported Capability        |
|  - skill bundle                          |
|  - plugin pack                           |
|  - connector manifest                    |
|  - bundled script content                |
+------------------------------------------+
         |
         | Stage before activation
         v
+------------------------------------------+
|      Capability Bundle Security          |
|  - structural validation                 |
|  - content heuristics                    |
|  - package intelligence lookups          |
+------------------------------------------+
         |
         | clean / warning / quarantined
         v
+-------------------+   +------------------+
| Managed Active    |   | Managed Quarantine|
| - visible to load |   | - excluded from   |
| - report sidecar  |   |   discovery       |
| - digest tracked  |   | - report retained |
+-------------------+   +------------------+
```

Imported skills, plugin packs, declarative connector manifests, and bundled scripts are treated as a separate trust boundary from built-in content.

### Managed Imports

For imported skills and imported packs that CoWork installs into managed storage:
- the bundle is staged in a temp location before activation
- structural checks reject path escapes, unsafe manifest references, and unexpected executable/binary payloads
- content heuristics inspect imported text and script surfaces for high-confidence malicious behavior
- inferred `npx` and `uvx` package executions can be checked against package-malware intelligence
- blocking findings move the bundle into quarantine instead of registering it
- warning-only findings still allow install, but the UI shows a persisted report and warning badge
- CoWork stores a bundle digest and rechecks it on later discovery so post-install tampering can trigger quarantine

### Unmanaged Local Bundles

Read-only local skill directories and unmanaged local pack folders are treated more conservatively in v1:
- CoWork can compute a report and surface warning badges
- those bundles are not auto-quarantined or blocked solely because they are local and unmanaged
- operators must review and remove or relocate them manually if the findings are unacceptable

### Intelligence Availability

Package-intelligence checks are additive, not the sole gate:
- if local structural or heuristic checks find a blocking issue, the bundle is quarantined
- if network-backed package intelligence is temporarily unavailable and local checks are otherwise clean, install can continue with a warning state
- persisted reports record whether package intelligence was unavailable during the scan

## Channel Boundary

```
+------------------------------------------+
|           External Channel                |
|  (Telegram, Discord, Slack, etc.)        |
+------------------------------------------+
         |
         | Security Mode
         v
+------------------------------------------+
|         Security Layer                    |
|  - Pairing code verification             |
|  - Allowlist checking                    |
|  - User authentication                   |
+------------------------------------------+
         |
         | Context Policy
         v
+------------------------------------------+
|         Context Restrictions              |
|  DM: Full access                          |
|  Group: Memory tools blocked              |
+------------------------------------------+
         |
         v
+------------------------------------------+
|         CoWork OS Processing              |
+------------------------------------------+
```

### Channel Trust Levels

| Level | How Users Get It | Capabilities |
|-------|------------------|--------------|
| Untrusted | Default for unknown users | Access denied |
| Paired | Entered valid pairing code | Full context access |
| Allowlisted | Pre-configured in settings | Full context access |
| Open Mode | Any user | Full context access |

### Context-Based Restrictions

Even after authentication, capabilities vary by context:

**DM Context:**
- Full tool access
- No memory restrictions
- Clipboard read/write allowed

**Group Context:**
- Memory tools blocked (clipboard)
- Prevents data leakage to other group members
- Other tools function normally

## Network Boundary

```
+------------------------------------------+
|           CoWork OS                       |
+------------------------------------------+
         |
         | Network Permission
         v
+------------------------------------------+
|         Browser / Web Tools               |
|  - browser_navigate                       |
|  - browser_get_content                    |
|  - web_search                             |
+------------------------------------------+
         |
         | Domain Allowlist (optional)
         v
+------------------------------------------+
|           External Networks               |
|  - Internet (if network=true)            |
|  - Localhost only (if network=false)     |
+------------------------------------------+
```

### Network Controls

**Workspace Level:**
- `network: true` enables browser/web tools
- `network: false` blocks all external network access

**Guardrail Level:**
- `enforceAllowedDomains: true` limits to specific domains
- Domain allowlist restricts which sites can be accessed

**Sandbox Level:**
- Docker: `--network none` by default
- macOS: localhost only unless explicitly allowed

## Tool Boundary

```
+------------------------------------------+
|           Tool Execution                  |
+------------------------------------------+
         |
         | Permission Engine
         v
+------------------------------------------+
|         Policy Manager                    |
|  - Hard restrictions / denylist           |
|  - Guardrails / dangerous commands        |
|  - Workspace capability gates             |
|  - Workspace policy script                |
|  - Explicit permission rules              |
|  - Mode defaults and fallback escalation  |
+------------------------------------------+
         |
         | Allow / Deny / Ask
         v
+------------------------------------------+
|         User Approval / Rule Persistence   |
|  - Review exact reason and scope           |
|  - Approve or deny                         |
|  - Persist session/workspace/profile rules |
+------------------------------------------+
         |
         v
+------------------------------------------+
|         Sandboxed Execution               |
+------------------------------------------+
```

### Tool Risk Levels

| Risk Level | Examples | Behavior |
|------------|----------|----------|
| Read | read_file, list_directory | Auto-allowed if read permission |
| Write | write_file, create_directory | Auto-allowed if write permission and no rule blocks it |
| Destructive | delete_file, run_command | Usually prompts unless a rule or mode changes the outcome |
| System | screenshot, clipboard | Context-dependent |
| Network | browser_navigate | Requires network permission and may still prompt under default mode |

### Approval Gates

Some operations usually require user approval:
- Shell command execution
- File deletion
- Destructive operations
- External side effects without matching allow rules

The approval shows:
- Tool name and description
- Parameters being used
- Exact reason and matched rule when available
- Allows user to approve or deny

Workspace-local rules can also be browsed and removed from Settings so the current policy is
visible without waiting for the next prompt.

## Trust Hierarchy

```
Most Trusted
    |
    +-- Local Desktop UI
    |     - Direct user interaction
    |     - Full approval capability
    |
    +-- Private DM (Paired)
    |     - Authenticated user
    |     - Full tool access
    |
    +-- Group Chat (Paired)
    |     - Authenticated user
    |     - Memory tools restricted
    |
    +-- Open Mode
    |     - Any user
    |     - Same as paired access
    |
    +-- Unknown User
          - No access
          - Must pair first
Least Trusted
```

ENGINE DEVELOPMENT RULES — COON TREE

==================================================
CORE DEBUGGING WORKFLOW
==================================================

TRACE → RECONSTRUCT → PATCH

Never patch behavior before confirming the lifecycle that produces the bug.

Required sequence:

1. Instrument lifecycle events.
2. Capture a full trace of the bug.
3. Reconstruct the event order.
4. State the causal chain producing the bug.
5. Only then generate a behavior patch.

Never perform:
TRACE → PATCH

Always perform:
TRACE → RECONSTRUCT → PATCH


==================================================
PATCH TYPES
==================================================

Diagnostic Patch
Purpose: observe system behavior.

Allowed:
- trace logs
- instrumentation
- temporary guards
- lifecycle diagnostics

Disallowed:
- behavior changes
- architectural changes
- state mutations

Behavior Patch
Purpose: modify logic to fix a confirmed bug.

Requirement:
Behavior patches must follow a diagnostic patch when lifecycle behavior is unknown.


==================================================
HYPOTHESIS RULE
==================================================

Every debugging patch candidate must state:

1. The causal chain producing the bug.
2. The trace evidence supporting the chain.
3. The single change expected to break that chain.

Example format:

CAUSAL CHAIN
Event A → Event B → incorrect state mutation → UI artifact

TRACE EVIDENCE
Observed lifecycle logs confirming event sequence.

PATCH
Modify behavior at the source event producing the incorrect mutation.


==================================================
STATE MUTATION TRACE RULE
==================================================

All unexpected state mutations must be traced at the mutation boundary.

For Coon Tree this means tracing calls to:

stateManager.apply()

Specifically log when the following operations occur:

- SYNC_ADD_BRANCH
- SYNC_ADD_TAB
- SYNC_REMOVE
- SYNC_WIN_FOCUS

The debugging objective is to identify the exact event source producing the mutation.


==================================================
WINDOW TRACKING MODEL
==================================================

Branch nodes represent real browsing windows only.

Extension UI surfaces must never enter the browsing tree.

Examples of UI surfaces:

- extension panels
- extension pop-out windows
- devtools windows
- chrome extension manager windows

These windows are considered tooling UI, not browsing state.


==================================================
INVALID CHROME OBJECT RULE
==================================================

Chrome transitional identifiers must never mutate state.

Do not mutate state when:

windowId == -1
tabId == -1

These identifiers represent transitional Chrome states (NO_WINDOW / NO_TAB).


==================================================
DEBUGGER CHAT USAGE
==================================================

Debugger chat is responsible for lifecycle reconstruction.

Recommended workflow:

Dev → instrumentation
Debugger → lifecycle explanation
Dev → patch candidate

Avoid patching before lifecycle reconstruction.


==================================================
TEMPORARY DEBUG INSTRUMENTATION
==================================================

Temporary lifecycle tracing is encouraged during engine stabilization.

Instrumentation should:

- expose Chrome lifecycle ordering
- expose state mutation calls
- help reconstruct event flow

After stabilization:

- remove traces
OR
- gate them behind a debug flag


==================================================
PATCH SCOPING RULE
==================================================

Each patch must address a single confirmed cause.

Avoid multi-hypothesis patches.

One patch = one causal chain.


==================================================
GIT COMMIT NAMING STYLE
==================================================

Use concise descriptive commit messages.

Examples:

CT003 — lifecycle debug instrumentation
CT004 — exclude extension panel tab from tree

Format:

CT### — short description
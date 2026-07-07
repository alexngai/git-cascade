# AGENTS.md - git-cascade Codebase Guide

## What is git-cascade?

A coordination layer for multiple AI agents working concurrently on a shared git repository. It provides database-backed (SQLite) tracking of streams (branches), operations (audit trail), and changes (stable identity across rebases), plus cascade rebase, deferred conflict handling, agent-isolated worktrees, and optional stacked review.

## Quick Start

```typescript
import { MultiAgentRepoTracker } from 'git-cascade';

const tracker = new MultiAgentRepoTracker({ repoPath: '/path/to/repo' });

const streamId = tracker.createStream({ name: 'feature', agentId: 'agent-1' });

const worktree = '/path/to/repo/.worktrees/agent-1';
tracker.createWorktree({ agentId: 'agent-1', path: worktree, branch: `stream/${streamId}` });

tracker.commitChanges({ streamId, agentId: 'agent-1', worktree, message: 'feat: add X' });

tracker.close();
```

See `README.md` for the full walkthrough (fork/sync/merge) and `docs/OVERVIEW.md` for architecture detail.

## Project Structure

```
src/
├── index.ts        # Main barrel export
├── tracker.ts      # MultiAgentRepoTracker class - start here
├── streams.ts      # Stream CRUD, fork/merge/rebase, conflict clearing
├── operations.ts   # Operation logging (audit trail)
├── changes.ts      # Change identity tracking across rebases
├── conflicts.ts    # Conflict record management
├── cascade.ts      # Cascade rebase propagation
├── stacks.ts       # Review blocks (stacked review)
├── dependencies.ts # Stream dependency tracking
├── rollback.ts     # Rollback operations
├── worktrees.ts    # Agent worktree management
├── guards.ts       # Optimistic concurrency
├── snapshots.ts    # Working copy snapshots
├── gc.ts           # Garbage collection & archiving
├── recovery.ts     # Crash recovery, checkpoints, health check
├── merge-queue.ts  # Merge queue coordination
├── worker-tasks.ts # Higher-level task lifecycle on top of streams
├── diff-stacks.ts  # Checkpoint-based diff stacks / cherry-pick
├── reconcile.ts    # DB/git reconciliation
├── errors.ts       # Custom error types
├── db/             # SQLite schema, migrations, table naming
├── models/         # TS interfaces/types per domain concept
├── git/            # Git command wrappers
├── events/         # Event schema (emit hook)
├── diff-rpc/       # Hub<->sidecar diff-fetch schema
└── action-rpc/     # Hub->sidecar action-request schema
```

## Core Concepts

### Streams (`src/streams.ts`)
- **What:** Logical work units, 1:1 with git branches (`stream/<id>`)
- **Status:** `active` | `paused` | `merged` | `abandoned` | `conflicted`
- **Key functions:** `createStream`, `forkStream`, `mergeStream`, `syncWithParent`, `rebaseOntoStream`, `clearConflict`

### Operations (`src/operations.ts`)
- **What:** Audit trail of all mutations for rollback capability
- **Types:** `commit`, `amend`, `rebase`, `merge`, `cherry_pick`, `rollback`, `reset`
- **Key functions:** `recordOperation`, `getOperations`, `getOperationChain`

### Changes (`src/changes.ts`)
- **What:** Stable identity that survives git rebases via `Change-Id` trailers
- **Status:** `active` | `squashed` | `dropped` | `merged`
- **Key functions:** `createChange`, `getChangeByCommit`, `getChangeByHistoricalCommit`, `recordSquash`, `recordSplit`

### Conflicts (`src/conflicts.ts`)
- **What:** Deferred conflict tracking - conflicts don't block the system
- **Strategies:** `abort`, `ours`, `theirs`, `agent`, `manual`
- **Key functions:** `createConflict`, `resolveConflict`, `getConflictForStream`

### Cascade Rebase (`src/cascade.ts`)
- **What:** Propagates rebases to dependent streams automatically
- **Strategies:** `stop_on_conflict`, `skip_conflicting`, `defer_conflicts`
- **Key function:** `cascadeRebase`

### Review Blocks (`src/stacks.ts`)
- **What:** PR-like reviewable commit groups (opt-in via `enableStackedReview`)
- **Status:** `draft` | `review` | `approved` | `merged`
- **Key functions:** `createReviewBlock`, `setReviewStatus`, `getStack`, `autoPopulateStack`

### Event Emission (`src/events/index.ts`)
- **What:** Optional hook for observing cascade operations. Transport-agnostic (`emit` is a plain function).
- **MAP-compatible by design:** Default method names use the MAP vendor-extension convention (`x-cascade/stream.opened`, `x-cascade/stream.committed`, `x-cascade/stream.merged`, `x-cascade/stream.conflicted`, `x-cascade/stream.abandoned`). Runtimes embedding cascade alongside a MAP connection forward emitted events verbatim as MAP notifications — no translation needed.
- **Configurable prefix:** `TrackerOptions.eventPrefix` (default `x-cascade`). Only the prefix varies; suffixes are fixed. Consumers narrowing on event type should match on the suffix (see `matchCascadeSuffix`).
- **Fire-and-forget:** Emits fire synchronously after the corresponding DB write, before the tracker method returns. Exceptions in the callback are caught and discarded. No emitter = no runtime cost beyond a single null check.
- **Key exports:** `CASCADE_METHODS` (default-prefixed names), `CASCADE_METHOD_SUFFIXES` (canonical suffixes), `buildCascadeMethods(prefix)`, `matchCascadeSuffix(method)`, `CascadeEmitter`, payload types (`StreamOpenedParams`, etc.), and `CascadeCapability` — the `cascade` capability-block schema a participant advertises to a coordination hub (`canServeDiff` / `canAct` / `emitsConflicts` / `autoCloseOnMerge`).

### Diff RPC schema (`src/diff-rpc/index.ts`)
- **What:** Hub <-> sidecar on-demand unified diff fetch — passive types + method-name constants. No runtime, no transport.
- **Wire methods:** `cascade/diff.request` (hub -> sidecar), `cascade/diff.response` (sidecar -> hub, inline or streaming announcement), `cascade/diff.chunk` (sidecar -> hub, post-streaming follow-ups).
- **Key exports:** `CASCADE_DIFF_METHODS`, `CASCADE_DIFF_METHOD_SET`, `CascadeDiffMethod`, tuning constants (`DIFF_INLINE_THRESHOLD_BYTES`, `DIFF_CHUNK_SIZE_BYTES`, `DIFF_REQUEST_TIMEOUT_MS`, `DIFF_MAX_RAW_BYTES`), payload types (`CascadeDiffRequestParams`, `CascadeDiffInlineResponse`, `CascadeDiffStreamingResponse`, `CascadeDiffErrorResponse`, `CascadeDiffResponseParams`, `CascadeDiffChunkParams`), method-keyed type map (`CascadeDiffMethodMap`), type guards (`isInlineResponse`, `isStreamingResponse`, `isErrorResponse`).
- **Subpath export:** `git-cascade/diff-rpc`.

### Action RPC schema (`src/action-rpc/index.ts`)
- **What:** Hub -> sidecar command channel for cascade operations — passive types + method-name constants. The complement to the `x-cascade/stream.*` event vocabulary: events flow runtime -> hub, action requests flow hub -> runtime. Fire-and-forget; the resulting event provides observability.
- **Wire methods:** `x-cascade/request.merge`, `x-cascade/request.abandon`, `x-cascade/request.pause`, `x-cascade/request.resume`, `x-cascade/request.resolve`, `x-cascade/request.push`, `x-cascade/request.commit`.
- **Capability gating:** A hub should only send these when the sidecar declares `cascade.canAct: true` on its `CascadeCapability` block. Sending to a `canAct: false` participant silently no-ops.
- **Key exports:** `CASCADE_ACTION_METHODS`, `CASCADE_ACTION_METHOD_SET`, `CascadeAction`, `CascadeActionMethod`, per-action param interfaces (`CascadeActionMergeParams`, etc.), `CascadeActionParams` union, `CascadeActionParamsMap`, `CascadeActionMethodMap`.
- **Subpath export:** `git-cascade/action-rpc`.

Example:
```typescript
const tracker = new MultiAgentRepoTracker({
  repoPath: '/path/to/repo',
  emit: (method, params) => mapClient.notify(method, params),  // forward to MAP
  eventPrefix: 'x-acme-cascade',  // optional; defaults to 'x-cascade'
});
```

## Key Interfaces

```typescript
// src/models/stream.ts
interface Stream {
  id: string;
  name: string;
  agentId: string;
  baseCommit: string;
  parentStream?: string;
  status: 'active' | 'paused' | 'merged' | 'abandoned' | 'conflicted';
}

// src/models/change.ts
interface Change {
  id: string;           // Change-Id (stable across rebases)
  streamId: string;
  currentCommit: string;
  commitHistory: CommitRecord[];
  status: 'active' | 'squashed' | 'dropped' | 'merged';
}

// src/models/stream.ts
type ConflictStrategy = 'abort' | 'ours' | 'theirs' | 'agent' | 'manual';
```

## Database (`src/db/database.ts`)

SQLite with WAL mode. Key tables:
- `streams` - Work units
- `operations` - Audit trail
- `changes` - Identity tracking
- `conflicts` - Deferred conflicts
- `review_blocks` / `stack_entries` - Stacked review
- `agent_worktrees` - Agent isolation
- `stream_guards` - Optimistic concurrency

## Common Patterns

### Creating a stream and committing
```typescript
const stream = tracker.createStream({ name: 'feature', agentId });
const wt = path.join(repoPath, '.worktrees', agentId);
tracker.createWorktree({ agentId, path: wt, branch: `stream/${stream}` });
// ... make file changes ...
tracker.commitChanges({ streamId: stream, message: 'feat: X', agentId, worktree: wt });
```

### Syncing with parent (rebase)
```typescript
// 'ours' keeps current branch changes on conflict
// 'theirs' accepts incoming changes
// 'abort' stops and marks stream conflicted
const result = tracker.syncWithParent(streamId, agentId, worktree, 'ours');
if (!result.success) {
  console.log('Conflicts:', result.conflicts);
}
```

### Handling conflicted streams
```typescript
import * as streams from './src/streams.js';

// Check if conflicted
const stream = tracker.getStream(streamId);
if (stream?.status === 'conflicted') {
  // Clear conflict and reset
  streams.clearConflict(db, streamId, worktree);
}
```

### Cascade rebase
```typescript
import * as cascade from './src/cascade.js';

const result = cascade.cascadeRebase(db, repoPath, {
  rootStream: parentStreamId,
  agentId,
  worktree: { mode: 'callback', provider: (id) => getWorktreePath(id) },
  strategy: 'skip_conflicting',
});
// result.updated - successfully rebased streams
// result.failed - streams with conflicts
```

## Error Handling (`src/errors.ts`)

Key errors to catch:
- `StreamConflictedError` - Stream blocked by unresolved conflict
- `ConflictError` - Rebase/merge conflict occurred
- `CyclicDependencyError` - Circular dependency detected
- `LockError` - Stream locked by another agent
- `DesyncError` - Database and git out of sync

## Testing

```bash
npm test                           # Run tests (watch mode via vitest)
npm run test:run                   # Run all tests once
npm run test:e2e                   # Run e2e tests only (RUN_SLOW_TESTS=true)
npx vitest run -t "stream"         # Run tests matching pattern
```

Test files mirror source structure: `tests/streams.test.ts` -> `src/streams.ts`, `tests/e2e/*.test.ts` -> integration scenarios.

## Build & Development

```bash
npm run build      # Compile TypeScript (tsc)
npm run typecheck  # Type check without emit
npm run lint       # ESLint on src
npm run format     # Prettier on src + tests
npm test           # Run tests (vitest, watch mode)
npm run test:run   # Run tests once (CI-style)
```

## Key Files to Read First

1. **`src/tracker.ts`** - Main API, start here
2. **`src/streams.ts`** - Core stream operations
3. **`src/models/stream.ts`** - Key interfaces
4. **`src/db/database.ts`** - Schema definition
5. **`src/events/index.ts`** - Event schema + MAP-compatibility docs
6. **`docs/OVERVIEW.md`** - Detailed architecture documentation

## Architecture Notes

- **Database-first:** SQLite is source of truth; git operations verify against DB
- **Optimistic concurrency:** Guards detect but don't block concurrent modifications
- **Deferred conflicts:** Conflicts recorded, don't stop system operation
- **Stable identity:** Change-Ids in commit trailers survive rebases
- **Agent isolation:** Each agent gets dedicated git worktree

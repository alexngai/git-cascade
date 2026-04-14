# CLAUDE.md - git-cascade Codebase Guide

## What is git-cascade?

A coordination layer for multiple AI agents working concurrently on a shared git repository. It provides database-backed tracking of streams (branches), operations (audit trail), and changes (stable identity across rebases).

## Quick Start

```typescript
import { MultiAgentRepoTracker } from './src/index.js';

const tracker = new MultiAgentRepoTracker({ repoPath: '/path/to/repo' });
const stream = tracker.createStream({ name: 'feature', agentId: 'agent-1' });
tracker.commitChanges({ streamId: stream, message: 'feat: add X', agentId: 'agent-1', worktree: wt });
tracker.close();
```

## Project Structure

```
src/
├── index.ts          # Main exports
├── tracker.ts        # MultiAgentRepoTracker class (start here)
├── streams.ts        # Stream CRUD and lifecycle
├── operations.ts     # Operation logging (audit trail)
├── changes.ts        # Change identity tracking
├── conflicts.ts      # Conflict record management
├── cascade.ts        # Cascade rebase logic
├── stacks.ts         # Review blocks (stacked review)
├── dependencies.ts   # Stream dependency tracking
├── rollback.ts       # Rollback operations
├── worktrees.ts      # Agent worktree management
├── guards.ts         # Optimistic concurrency
├── snapshots.ts      # Working copy snapshots
├── gc.ts             # Garbage collection & archiving
├── recovery.ts       # Crash recovery
├── errors.ts         # Custom error types
├── db/
│   ├── database.ts   # SQLite schema & initialization
│   └── tables.ts     # Table name utilities
├── models/
│   ├── stream.ts     # Stream interfaces
│   ├── operation.ts  # Operation types
│   ├── change.ts     # Change identity models
│   ├── conflict.ts   # Conflict types
│   ├── stack.ts      # Review block models
│   └── ...
└── git/
    └── commands.ts   # Git command wrappers
```

## Core Concepts

### Streams (`src/streams.ts`)
- **What:** Logical work units, 1:1 with git branches (`stream/<id>`)
- **Status:** `active` | `paused` | `merged` | `abandoned` | `conflicted`
- **Key functions:** `createStream`, `forkStream`, `mergeStream`, `syncWithParent`, `rebaseOntoStream`

### Operations (`src/operations.ts`)
- **What:** Audit trail of all mutations for rollback capability
- **Types:** `commit`, `amend`, `rebase`, `merge`, `cherry_pick`, `rollback`, `reset`
- **Key functions:** `recordOperation`, `getOperations`, `getOperationChain`

### Changes (`src/changes.ts`)
- **What:** Stable identity that survives git rebases via `Change-Id` trailers
- **Status:** `active` | `squashed` | `dropped` | `merged`
- **Key functions:** `createChange`, `getChangeByCommit`, `recordSquash`, `recordSplit`

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
- **Key exports:** `CASCADE_METHODS` (default-prefixed names), `CASCADE_METHOD_SUFFIXES` (canonical suffixes), `buildCascadeMethods(prefix)`, `matchCascadeSuffix(method)`, `CascadeEmitter`, payload types (`StreamOpenedParams`, etc.).

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
npm test                           # Run all 447 tests
npm test -- tests/e2e              # Run e2e tests only
npm test -- -t "stream"            # Run tests matching pattern
```

Test files mirror source structure:
- `tests/streams.test.ts` → `src/streams.ts`
- `tests/e2e/*.test.ts` → Integration scenarios

## Build & Development

```bash
npm run build      # Compile TypeScript
npm run typecheck  # Type check without emit
npm test           # Run tests
```

## Key Files to Read First

1. **`src/tracker.ts`** - Main API, start here
2. **`src/streams.ts`** - Core stream operations
3. **`src/models/stream.ts`** - Key interfaces
4. **`src/db/database.ts`** - Schema definition
5. **`src/events/index.ts`** - Event schema + MAP-compatibility docs
6. **`docs/OVERVIEW.md`** - Detailed documentation

## Architecture Notes

- **Database-first:** SQLite is source of truth; git operations verify against DB
- **Optimistic concurrency:** Guards detect but don't block concurrent modifications
- **Deferred conflicts:** Conflicts recorded, don't stop system operation
- **Stable identity:** Change-Ids in commit trailers survive rebases
- **Agent isolation:** Each agent gets dedicated git worktree

# Dataplane: Multi-Agent Git Coordination System

## Overview

Dataplane is a coordination layer for multiple AI agents working concurrently on a shared git repository. It provides:

- **Stream-based workflows** - Logical work units that map 1:1 to git branches
- **Stable identity tracking** - Change IDs that survive rebases
- **Cascade rebase** - Automatic propagation of changes to dependent streams
- **Conflict management** - Deferred conflict handling with agent-based resolution
- **Stacked review** - PR-like reviewable units (opt-in)
- **Agent isolation** - Dedicated worktrees per agent
- **Full audit trail** - Operation logging for rollback and recovery

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    MultiAgentRepoTracker                        │
│  (Main coordination class - high-level API)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│    Streams    │    │   Operations  │    │    Changes    │
│  (work units) │    │ (audit trail) │    │  (identity)   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   Conflicts   │    │    Cascade    │    │    Stacks     │
│  (deferred)   │    │   (rebase)    │    │   (review)    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SQLite Database                            │
│  (15 tables, WAL mode, optimistic concurrency)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Git Repository                             │
│  (branches, worktrees, commits)                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### 1. Streams

A **stream** is the primary unit of work, mapping 1:1 to a git branch (`stream/<id>`).

```typescript
interface Stream {
  id: string;              // Unique identifier
  name: string;            // Human-readable name
  agentId: string;         // Owning agent
  baseCommit: string;      // Fork point
  parentStream?: string;   // Parent stream (if forked)
  status: StreamStatus;    // active | paused | merged | abandoned | conflicted
  enableStackedReview: boolean;
  metadata: Record<string, unknown>;
}
```

**Lifecycle:**
```
create → active → [work] → merged/abandoned
                    ↓
              conflicted → [resolve] → active
```

### 2. Operations

Every mutation is logged as an **operation** for audit and rollback:

```typescript
interface Operation {
  id: string;
  streamId: string;
  agentId: string;
  opType: 'commit' | 'amend' | 'rebase' | 'merge' | 'cherry_pick' | 'rollback' | 'reset';
  beforeState: string;     // Commit hash before
  afterState: string;      // Commit hash after
  parentOps: string[];     // DAG structure for complex rollbacks
  timestamp: number;
  metadata: Record<string, unknown>;
}
```

### 3. Changes (Stable Identity)

A **change** represents a logical unit of work that maintains identity across git rewrites (rebases):

```typescript
interface Change {
  id: string;              // Change-Id (matches commit trailer)
  streamId: string;
  description: string;     // First line of commit message
  currentCommit: string;   // Current commit hash
  commitHistory: Array<{   // All historical commits
    commit: string;
    timestamp: number;
    rewriteReason?: string;
  }>;
  status: 'active' | 'squashed' | 'dropped' | 'merged';
}
```

Changes use `Change-Id` trailers in commit messages (Gerrit-style) to track identity through rebases.

### 4. Conflicts

Conflicts are **deferred** - they don't block the system but are recorded for later resolution:

```typescript
interface ConflictRecord {
  id: string;
  streamId: string;
  conflictedFiles: string[];
  status: 'pending' | 'in_progress' | 'resolved' | 'abandoned';
  resolution?: {
    strategy: 'ours' | 'theirs' | 'manual' | 'agent';
    resolvedBy: string;
    resolvedAt: number;
  };
}
```

**Resolution Strategies:**
- `abort` - Stop and mark stream as conflicted (default)
- `ours` - Keep current branch changes
- `theirs` - Accept incoming changes
- `agent` - Call conflict handler for programmatic resolution
- `manual` - Leave for manual resolution

### 5. Review Blocks (Stacked Review)

Optional feature for organizing commits into PR-like reviewable units:

```typescript
interface ReviewBlock {
  id: string;
  streamId: string;
  stackName: string;       // Named stacks within a stream
  position: number;        // Order in stack
  title: string;
  reviewStatus: 'draft' | 'review' | 'approved' | 'merged';
  commits: StackEntry[];
}
```

## Key Features

### Cascade Rebase

When a parent stream is updated, changes automatically propagate to dependent streams:

```
main ──────────────●──────────────●
                   │              │
feature-a ─────────●──────────────┼──● (auto-rebased)
                   │              │  │
feature-b ─────────┴──●───────────┴──● (auto-rebased)
```

**Strategies:**
- `stop_on_conflict` - Stop cascade on first conflict
- `skip_conflicting` - Continue cascade, mark conflicting streams
- `defer_conflicts` - Continue cascade, record conflicts for later

### Agent Isolation

Each agent operates in a dedicated git worktree:

```
.worktrees/
├── agent-1/          # Agent 1's isolated workspace
├── agent-2/          # Agent 2's isolated workspace
└── agent-3/          # Agent 3's isolated workspace
```

Worktrees provide filesystem isolation so agents can work concurrently without stepping on each other.

### Optimistic Concurrency

Instead of locks, dataplane uses **guards** for conflict detection:

```typescript
// Read current state
const readTime = Date.now();
const guard = guards.getGuard(db, streamId);

// ... do work ...

// Before writing, validate no one else modified
if (guards.validateGuard(db, streamId, agentId, readTime)) {
  // Safe to proceed
  guards.touchGuard(db, streamId, agentId);
} else {
  // Another agent modified - handle conflict
}
```

### Working Copy Snapshots

Protect uncommitted work with git stash-based snapshots:

```typescript
// Before risky operation
const snapshotId = snapshots.snapshot(db, worktree, agentId, 'pre-rebase');

// If operation fails, restore
snapshots.restore(db, snapshotId, worktree);
```

## API Reference

### MultiAgentRepoTracker

The main coordination class:

```typescript
const tracker = new MultiAgentRepoTracker({
  repoPath: '/path/to/repo',
  dbPath: '/path/to/tracker.db',  // Optional, defaults to .dataplane/tracker.db
  skipRecovery: false,            // Run startup recovery
});

// Stream Operations
tracker.createStream({ name: 'feature', agentId: 'agent-1' });
tracker.forkStream({ parentStreamId, name: 'child', agentId });
tracker.mergeStream({ sourceStream, targetStream, agentId, worktree });
tracker.abandonStream(streamId, 'reason');
tracker.getStream(streamId);
tracker.listStreams({ agentId?, status? });

// Worktree Management
tracker.createWorktree({ agentId, path, branch });
tracker.getWorktree(agentId);
tracker.deallocateWorktree(agentId);

// Commit with Change Tracking
tracker.commitChanges({
  streamId,
  agentId,
  worktree,
  message: 'feat: add feature',
});

// Rebase Operations
tracker.syncWithParent(streamId, agentId, worktree, 'ours');
tracker.rebaseOntoStream({ sourceStream, targetStream, agentId, worktree });

// Stack Operations (opt-in)
tracker.createReviewBlock({ streamId, title, commits });
tracker.setReviewStatus({ reviewBlockId, status, reviewer });
tracker.getStack(streamId, stackName?);

// Rollback
tracker.rollbackN({ streamId, n: 2, worktreePath });
tracker.rollbackToOperation({ streamId, operationId, worktreePath });

// Health & Recovery
tracker.healthCheck();
tracker.close();
```

### Low-Level APIs

For advanced use cases, low-level modules are exposed:

```typescript
import * as streams from 'dataplane/streams';
import * as changes from 'dataplane/changes';
import * as conflicts from 'dataplane/conflicts';
import * as cascade from 'dataplane/cascade';
import * as gc from 'dataplane/gc';
import * as recovery from 'dataplane/recovery';
import * as guards from 'dataplane/guards';
import * as snapshots from 'dataplane/snapshots';
```

## Database Schema

15 tables managed in SQLite with WAL mode:

| Table | Purpose |
|-------|---------|
| `streams` | Logical work units (branches) |
| `operations` | Audit trail of all mutations |
| `changes` | Stable identity tracking |
| `review_blocks` | Reviewable commit groups |
| `stack_entries` | Commits within review blocks |
| `dependencies` | Stream relationships |
| `conflicts` | Deferred conflict records |
| `agent_worktrees` | Agent filesystem isolation |
| `stream_locks` | Exclusive operation locks |
| `stream_guards` | Optimistic concurrency |
| `wc_snapshots` | Working copy snapshots |
| `archived_streams` | Historical stream records |
| `gc_config` | Garbage collection settings |
| `operation_checkpoints` | Crash recovery markers |
| `stack_configs` | Per-stream stack configuration |

## Configuration

### GC Configuration

```typescript
gc.setGCConfig(db, {
  autoArchiveOnMerge: true,      // Archive streams after merge
  autoArchiveOnAbandon: true,    // Archive abandoned streams
  archiveRetentionDays: 30,      // Days before pruning
  deleteGitBranches: true,       // Delete branches on prune
  deleteWorktrees: true,         // Clean up worktrees
  runRecoveryOnStartup: true,    // Run recovery on init
});
```

### Stack Configuration

```typescript
stacks.setStackConfig(db, streamId, 'default', {
  autoPopulate: true,            // Auto-create blocks for commits
  groupingStrategy: 'per-commit', // One block per commit
  rebuildBehavior: {
    matchStrategy: 'change-id',  // Match by Change-Id on rebuild
    deleteOrphaned: true,
  },
  reviewWorkflow: {
    requireApproval: true,
    allowedReviewers: ['reviewer-1', 'reviewer-2'],
  },
});
```

## Error Handling

Custom error types for specific failure scenarios:

```typescript
import {
  ConflictError,              // Merge/rebase conflict
  StreamNotFoundError,        // Missing stream
  StreamConflictedError,      // Stream blocked by conflict
  UnresolvedConflictsError,   // Outstanding conflicts
  CyclicDependencyError,      // Circular dependency
  DiamondDependencyError,     // Multiple parents
  DesyncError,                // DB/git out of sync
  LockError,                  // Stream locked
  ConcurrentModificationError, // Guard violation
  BranchNotFoundError,
  WorktreeError,
} from 'dataplane';
```

## Test Coverage

447 tests across 25 test files:

| Category | Tests | Coverage |
|----------|-------|----------|
| Unit Tests | 417 | Core functionality |
| E2E Tests | 30 | Integration scenarios |

**E2E Test Suites:**
- `multi-agent-workflow.test.ts` - Agent coordination
- `stacked-review.test.ts` - Review workflow
- `conflict-resolution-e2e.test.ts` - Conflict handling
- `gc-lifecycle.test.ts` - Archive/prune lifecycle

## Usage Example

```typescript
import { MultiAgentRepoTracker } from 'dataplane';

// Initialize tracker
const tracker = new MultiAgentRepoTracker({
  repoPath: '/path/to/repo',
});

// Agent 1 creates a feature stream
const streamA = tracker.createStream({
  name: 'feature-auth',
  agentId: 'agent-1',
});

// Create dedicated worktree
const wtA = '/path/to/.worktrees/agent-1';
tracker.createWorktree({
  agentId: 'agent-1',
  path: wtA,
  branch: `stream/${streamA}`,
});

// Make commits with change tracking
tracker.commitChanges({
  streamId: streamA,
  agentId: 'agent-1',
  worktree: wtA,
  message: 'feat: add authentication module',
});

// Agent 2 forks to work on a related feature
const streamB = tracker.forkStream({
  parentStreamId: streamA,
  name: 'feature-oauth',
  agentId: 'agent-2',
});

// When Agent 1's stream is updated, Agent 2 syncs
const result = tracker.syncWithParent(streamB, 'agent-2', wtB, 'ours');
if (!result.success) {
  // Handle conflict
  console.log('Conflicts:', result.conflicts);
}

// Merge when ready
tracker.mergeStream({
  sourceStream: streamA,
  targetStream: 'main',
  agentId: 'agent-1',
  worktree: wtA,
});

// Cleanup
tracker.close();
```

## Design Principles

1. **Database as Source of Truth** - SQLite tracks all state; git operations verify against DB
2. **Optimistic Concurrency** - Guards detect conflicts without blocking
3. **Deferred Conflict Resolution** - Conflicts don't stop the system
4. **Stable Identity** - Change-Ids survive git rewrites
5. **Agent Isolation** - Worktrees prevent filesystem contention
6. **Full Audit Trail** - All mutations logged for rollback/recovery
7. **Extensible Metadata** - All entities support custom data

## License

MIT

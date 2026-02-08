# git-cascade

A coordination layer for multiple AI agents working concurrently on a shared git repository.

## Features

- **Stream-based Workflows** - Logical work units that map 1:1 to git branches with full lifecycle management
- **Stable Identity Tracking** - Change-Ids that survive git rebases, enabling logical change tracking across rewrites
- **Cascade Rebase** - Automatic propagation of changes to dependent streams with configurable conflict strategies
- **Deferred Conflict Handling** - Conflicts don't block the system; they're recorded and resolved when ready
- **Agent Isolation** - Dedicated git worktrees per agent for concurrent work without filesystem contention
- **Stacked Review** - Optional PR-like reviewable units for incremental code review workflows
- **Full Audit Trail** - Operation logging enables rollback and crash recovery
- **Optimistic Concurrency** - Guards detect concurrent modifications without blocking

## Installation

```bash
npm install git-cascade
```

## Quick Start

```typescript
import { MultiAgentRepoTracker } from 'git-cascade';

// Initialize tracker
const tracker = new MultiAgentRepoTracker({
  repoPath: '/path/to/repo',
});

// Create a stream (work unit)
const streamId = tracker.createStream({
  name: 'feature-auth',
  agentId: 'agent-1',
});

// Create isolated worktree for the agent
const worktree = '/path/to/repo/.worktrees/agent-1';
tracker.createWorktree({
  agentId: 'agent-1',
  path: worktree,
  branch: `stream/${streamId}`,
});

// Make commits with automatic change tracking
tracker.commitChanges({
  streamId,
  agentId: 'agent-1',
  worktree,
  message: 'feat: add authentication module',
});

// Fork a child stream
const childStream = tracker.forkStream({
  parentStreamId: streamId,
  name: 'feature-oauth',
  agentId: 'agent-2',
});

// Sync child with parent updates
const result = tracker.syncWithParent(childStream, 'agent-2', childWorktree, 'ours');

// Merge when ready
tracker.mergeStream({
  sourceStream: streamId,
  targetStream: 'main-stream',
  agentId: 'agent-1',
  worktree,
});

// Cleanup
tracker.close();
```

## Core Concepts

### Streams

A stream is the primary unit of work, representing a logical branch of development:

```typescript
const stream = tracker.createStream({
  name: 'feature-name',
  agentId: 'agent-1',
  enableStackedReview: true,  // Optional: enable PR-like review blocks
});
```

Streams have lifecycle states: `active` → `merged` | `abandoned` | `conflicted`

### Changes

Changes maintain stable identity across git rebases using `Change-Id` trailers:

```typescript
// Commits automatically get Change-Id trailers
tracker.commitChanges({
  streamId,
  message: 'feat: add feature',
  agentId: 'agent-1',
  worktree,
});

// Find a change by any of its historical commits
const change = tracker.getChangeByHistoricalCommit(oldCommitHash);
```

### Conflict Resolution

Conflicts are deferred and can be resolved with different strategies:

```typescript
// Sync with automatic resolution
const result = tracker.syncWithParent(streamId, agentId, worktree, 'ours');

// Strategies:
// - 'abort'  - Stop and mark stream conflicted (default)
// - 'ours'   - Keep current branch changes
// - 'theirs' - Accept incoming changes
// - 'agent'  - Call custom conflict handler
```

### Cascade Rebase

Changes propagate automatically to dependent streams:

```typescript
import * as cascade from 'git-cascade/cascade';

cascade.cascadeRebase(db, repoPath, {
  rootStream: parentId,
  agentId: 'agent-1',
  strategy: 'skip_conflicting',  // Continue past conflicts
  worktree: {
    mode: 'callback',
    provider: (streamId) => getWorktreePath(streamId),
  },
});
```

## API Overview

### MultiAgentRepoTracker

| Method | Description |
|--------|-------------|
| `createStream()` | Create a new stream |
| `forkStream()` | Fork a child stream |
| `mergeStream()` | Merge stream into target |
| `syncWithParent()` | Rebase onto parent stream |
| `commitChanges()` | Commit with change tracking |
| `createWorktree()` | Create agent worktree |
| `rollbackN()` | Rollback N operations |
| `getStack()` | Get review blocks |
| `healthCheck()` | Check system health |

### Low-Level APIs

```typescript
import * as streams from 'git-cascade/streams';
import * as changes from 'git-cascade/changes';
import * as conflicts from 'git-cascade/conflicts';
import * as cascade from 'git-cascade/cascade';
import * as gc from 'git-cascade/gc';
import * as recovery from 'git-cascade/recovery';
```

## Configuration

### Garbage Collection

```typescript
import * as gc from 'git-cascade/gc';

gc.setGCConfig(db, {
  autoArchiveOnMerge: true,
  autoArchiveOnAbandon: true,
  archiveRetentionDays: 30,
  deleteGitBranches: true,
  runRecoveryOnStartup: true,
});
```

### Tracker Options

```typescript
const tracker = new MultiAgentRepoTracker({
  repoPath: '/path/to/repo',
  dbPath: '/path/to/tracker.db',  // Default: .git-cascade/tracker.db
  tablePrefix: 'myapp_',          // Optional table prefix
  skipRecovery: false,            // Run recovery on startup
});
```

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** - Quick reference for coding agents
- **[docs/OVERVIEW.md](./docs/OVERVIEW.md)** - Comprehensive architecture documentation

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests (447 tests)
npm test

# Type check
npm run typecheck
```

## Requirements

- Node.js 18+
- Git 2.20+

## License

MIT

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
- **Event Emission (opt-in)** - Emit MAP-compatible events (`x-cascade/stream.*`) for streams opened, commits recorded, merges completed, conflicts detected, and streams abandoned. Configurable prefix; transport-agnostic (no MAP dependency).

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

### Event Emission (MAP-compatible)

git-cascade can emit structured events after each operation. Events are opt-in via an `emit` callback — when omitted, there is no runtime cost beyond a single null check per operation. git-cascade has no transport dependency; the callback decides how to forward events (log, event bus, JSON-RPC, etc.).

Default method names follow the [MAP](https://github.com/modelcontextprotocol/specification) vendor-extension convention (`x-cascade/stream.opened`, `x-cascade/stream.committed`, etc.), so runtimes embedding git-cascade alongside a MAP connection can forward events verbatim as MAP notifications — no translation layer needed.

```typescript
import {
  MultiAgentRepoTracker,
  CASCADE_METHOD_SUFFIXES,
  matchCascadeSuffix,
} from 'git-cascade';

const tracker = new MultiAgentRepoTracker({
  repoPath: '/path/to/repo',
  // Forward events to a MAP client as notifications
  emit: (method, params) => mapClient.notify(method, params),
});

// Emitted events (default prefix):
//   x-cascade/stream.opened       — createStream / forkStream / trackExistingBranch
//   x-cascade/stream.committed    — commitChanges
//   x-cascade/stream.merged       — mergeStream / completeTask
//   x-cascade/stream.conflicted   — conflict recorded (rebase/sync/merge/task-complete)
//   x-cascade/stream.abandoned    — abandonStream
```

**Configurable prefix.** Override the `x-cascade` prefix for branded deployments or namespace isolation. Only the prefix varies; suffixes are fixed.

```typescript
const tracker = new MultiAgentRepoTracker({
  repoPath: '/path/to/repo',
  emit: (method, params) => myEventBus.publish(method, params),
  eventPrefix: 'x-acme-cascade',  // → emits 'x-acme-cascade/stream.opened', etc.
});

// Narrow on the suffix to stay prefix-agnostic:
emit: (method, params) => {
  const suffix = matchCascadeSuffix(method);
  if (suffix === CASCADE_METHOD_SUFFIXES.STREAM_COMMITTED) {
    // ... params is StreamCommittedParams
  }
}
```

Events fire synchronously after the corresponding database write, in operation order. Exceptions thrown by the callback are caught and discarded — a misbehaving observer cannot break cascade operations.

See [`src/events/index.ts`](./src/events/index.ts) for full method names, payload types, and narrowing helpers.

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

### Event Schema

```typescript
import {
  // Default-prefixed method names (for default eventPrefix)
  CASCADE_METHODS,
  // Canonical suffixes (prefix-agnostic, always stable)
  CASCADE_METHOD_SUFFIXES,
  DEFAULT_CASCADE_PREFIX,
  // Build a method map with a custom prefix
  buildCascadeMethods,
  // Extract the canonical suffix from any method string
  matchCascadeSuffix,
  // Types
  type CascadeEmitter,
  type CascadeMethodSuffix,
  type CascadeSuffixMap,
  type StreamOpenedParams,
  type StreamCommittedParams,
  type StreamMergedParams,
  type StreamConflictedParams,
  type StreamAbandonedParams,
} from 'git-cascade';
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
  emit: (method, params) => {},   // Optional event callback (see Event Emission)
  eventPrefix: 'x-cascade',       // Optional; default 'x-cascade'
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

# Run tests (750 tests)
npm test

# Type check
npm run typecheck
```

## Requirements

- Node.js 18+
- Git 2.20+

## License

MIT

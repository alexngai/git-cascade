# CLAUDE.md - git-cascade

git-cascade is a coordination layer for multiple AI agents working concurrently on a shared git repository. It provides SQLite-backed tracking of streams (logical work units mapped 1:1 to git branches), an operation audit trail, and stable change identity (via `Change-Id` trailers) that survives rebases — plus cascade rebase propagation, deferred conflict handling, agent-isolated worktrees, and optional stacked review.

## Build / Test / Run

```bash
npm run build      # Compile TypeScript (tsc)
npm run typecheck  # Type check without emit
npm run lint       # ESLint on src
npm test           # Run tests (vitest, watch mode)
npm run test:run   # Run tests once (CI-style)
npm run test:e2e   # Run e2e tests only
```

## Quick Start

```typescript
import { MultiAgentRepoTracker } from 'git-cascade';

const tracker = new MultiAgentRepoTracker({ repoPath: '/path/to/repo' });
const streamId = tracker.createStream({ name: 'feature', agentId: 'agent-1' });
tracker.createWorktree({ agentId: 'agent-1', path: worktreePath, branch: `stream/${streamId}` });
tracker.commitChanges({ streamId, agentId: 'agent-1', worktree: worktreePath, message: 'feat: add X' });
tracker.close();
```

## Top Conventions

- **Database-first**: SQLite is the source of truth; git operations are verified against the DB, not the other way around.
- **Deferred conflicts**: conflicts are recorded on the stream (`status: 'conflicted'`) rather than blocking execution; resolve via `syncWithParent` strategies (`abort` | `ours` | `theirs` | `agent` | `manual`) or `streams.clearConflict`.
- **Agent isolation**: each agent works in its own git worktree; never share a worktree across agents.
- **Low-level APIs** (`streams`, `changes`, `conflicts`, `cascade`, `gc`, `recovery`, etc.) are exported both from the main barrel and as subpaths (e.g. `git-cascade/events`, `git-cascade/diff-rpc`, `git-cascade/action-rpc`) — prefer the `MultiAgentRepoTracker` methods unless you need direct DB access.
- **Events are opt-in**: pass `emit` in `TrackerOptions` to receive MAP-compatible notifications (`x-cascade/stream.*`); omit it for zero overhead beyond a null check.

See `AGENTS.md` for the full codebase guide (module-by-module breakdown, key interfaces, error types, and common patterns).

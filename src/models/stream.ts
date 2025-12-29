/**
 * Stream data model and types.
 *
 * A Stream is a logical unit of work that maps 1:1 to a git branch.
 */

export type StreamStatus = 'active' | 'paused' | 'merged' | 'abandoned' | 'conflicted';

export interface Stream {
  /** Unique identifier (e.g., "abc12345") */
  id: string;
  /** Human-readable name (e.g., "feature-auth") */
  name: string;
  /** Owning agent identifier */
  agentId: string;
  /** Commit hash where stream branched from */
  baseCommit: string;
  /** ID of parent stream if forked */
  parentStream: string | null;
  /** Current status */
  status: StreamStatus;
  /** Unix timestamp (ms) when created */
  createdAt: number;
  /** Unix timestamp (ms) when last updated */
  updatedAt: number;
  /** Target stream ID if merged */
  mergedInto: string | null;
  /** Opt-in: track commits as reviewable stack entries */
  enableStackedReview: boolean;
  /** Extensible metadata */
  metadata: Record<string, unknown>;
}

export interface CreateStreamOptions {
  name: string;
  agentId: string;
  /** Branch or commit to base from (default: "main") */
  base?: string;
  /** Parent stream ID if forking */
  parentStream?: string;
  /** Enable stacked review workflow */
  enableStackedReview?: boolean;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface ForkStreamOptions {
  parentStreamId: string;
  name: string;
  agentId: string;
}

export type MergeStrategy = 'merge-commit' | 'squash' | 'rebase';

export interface MergeStreamOptions {
  sourceStream: string;
  targetStream: string;
  agentId: string;
  worktree: string;
  strategy?: MergeStrategy;
}

export interface MergeResult {
  success: boolean;
  newHead?: string;
  conflicts?: string[];
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rebase Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Conflict resolution strategy for rebase operations.
 */
export type ConflictStrategy =
  | 'abort'   // Abort rebase, return conflict info (default)
  | 'ours'    // Accept current branch changes
  | 'theirs'  // Accept incoming changes
  | 'agent'   // Call conflict handler for agent resolution (Phase 6)
  | 'manual'; // Fail out, let user resolve manually

/**
 * Information about a conflict during rebase.
 */
export interface ConflictInfo {
  /** File path with conflict */
  file: string;
  /** Conflict markers content (if available) */
  markers?: string;
}

/**
 * Handler function for agent-based conflict resolution.
 */
export type ConflictHandler = (
  conflicts: ConflictInfo[],
  worktree: string
) => Promise<boolean>;

/**
 * Options for rebaseOntoStream operation.
 */
export interface RebaseOntoStreamOptions {
  /** Stream to rebase */
  sourceStream: string;
  /** Stream to rebase onto */
  targetStream: string;
  /** Agent performing the rebase */
  agentId: string;
  /** Worktree path for git operations */
  worktree: string;
  /** Conflict resolution strategy (default: 'abort') */
  onConflict?: ConflictStrategy;
  /** Handler for agent-based conflict resolution */
  conflictHandler?: ConflictHandler;
  /** Timeout for conflict handler in ms (default: 300000 = 5 min) */
  conflictTimeout?: number;
  /**
   * Cascade rebase to dependent streams (default: true).
   * Set to false to disable automatic cascade.
   */
  cascade?: boolean;
}

/**
 * Result of a rebase operation.
 */
export interface RebaseResult {
  /** Whether rebase completed successfully */
  success: boolean;
  /** New head commit after rebase */
  newHead?: string;
  /** New base commit (target's head) */
  newBaseCommit?: string;
  /** Conflict information if rebase failed due to conflicts */
  conflicts?: ConflictInfo[];
  /** Conflict record ID if conflict was recorded */
  conflictId?: string;
  /** Error message if rebase failed */
  error?: string;
  /** Result of cascade rebase (if cascade was enabled) */
  cascadeResult?: import('./dependency.js').CascadeResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream Graph Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Node in the stream graph tree.
 */
export interface StreamNode {
  /** The stream at this node */
  stream: Stream;
  /** Child streams (forked from this stream) */
  children: StreamNode[];
  /** IDs of streams this stream depends on */
  dependencies: string[];
}

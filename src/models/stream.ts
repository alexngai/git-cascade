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
  /** Commit SHA where this stream branched from its parent (for DAG tracking) */
  branchPointCommit: string | null;
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
  /** Name of existing branch being tracked (for local mode) */
  existingBranch: string | null;
  /** Whether this stream is in local mode (tracking existing branch) */
  isLocalMode: boolean;
}

export interface CreateStreamOptions {
  name: string;
  agentId: string;
  /** Branch or commit to base from (default: "main") */
  base?: string;
  /** Parent stream ID if forking */
  parentStream?: string;
  /**
   * Commit SHA where this stream branched from its parent.
   * Used for DAG tracking to identify the exact point of divergence.
   */
  branchPointCommit?: string;
  /** Enable stacked review workflow */
  enableStackedReview?: boolean;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /**
   * Track an existing branch instead of creating a new one.
   * When set, the stream will track this branch without creating stream/<id>.
   * Use this for "local mode" where agents work on existing branches.
   */
  existingBranch?: string;
  /**
   * Whether to create a new git branch (default: true).
   * Set to false when using existingBranch to track an existing branch.
   */
  createBranch?: boolean;
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
  /** "Ours" version content (current branch) */
  ours?: string;
  /** "Theirs" version content (incoming changes) */
  theirs?: string;
  /** Base version content (common ancestor) */
  base?: string;
}

/**
 * Result of resolving a single file conflict.
 */
export interface FileResolution {
  /** File path that was resolved */
  file: string;
  /** Resolved content to write to the file */
  content: string;
}

/**
 * Result of conflict resolution from a handler.
 */
export interface ConflictResolutionResult {
  /** Whether resolution was successful */
  success: boolean;
  /** Resolved files (optional - if not provided, assumes files were modified in worktree) */
  resolvedFiles?: FileResolution[];
  /** Files that could not be resolved (will be left with conflict markers) */
  unresolvedFiles?: string[];
  /** Message describing the resolution */
  message?: string;
}

/**
 * Handler function for agent-based conflict resolution (simple version).
 * Returns true if conflicts were resolved in the worktree, false otherwise.
 */
export type ConflictHandler = (
  conflicts: ConflictInfo[],
  worktree: string
) => Promise<boolean>;

/**
 * Enhanced handler function for agent-based conflict resolution.
 * Can return either a boolean or detailed resolution result.
 */
export type EnhancedConflictHandler = (
  conflicts: ConflictInfo[],
  worktree: string,
  context: ConflictContext
) => Promise<boolean | ConflictResolutionResult>;

/**
 * Context provided to enhanced conflict handlers.
 */
export interface ConflictContext {
  /** Stream being rebased */
  sourceStream: string;
  /** Stream being rebased onto */
  targetStream: string;
  /** Current commit being applied */
  currentCommit: string;
  /** Total commits in rebase */
  totalCommits: number;
  /** Current commit index (0-based) */
  commitIndex: number;
}

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
  /** Handler for agent-based conflict resolution (simple) */
  conflictHandler?: ConflictHandler;
  /** Enhanced handler for agent-based conflict resolution (with context and resolution content) */
  enhancedConflictHandler?: EnhancedConflictHandler;
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

// ─────────────────────────────────────────────────────────────────────────────
// Stream Merge Types (DAG Tracking)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record of a merge event between two streams.
 * Used for DAG tracking to capture when streams are merged.
 */
export interface StreamMerge {
  /** Unique identifier for this merge event */
  id: string;
  /** Stream that was merged FROM (source) */
  sourceStreamId: string;
  /** Commit SHA in the source stream that was merged */
  sourceCommit: string;
  /** Stream that was merged INTO (target) */
  targetStreamId: string;
  /** Resulting merge commit SHA in the target */
  mergeCommit: string;
  /** Unix timestamp (ms) when merge was recorded */
  createdAt: number;
  /** Extensible metadata */
  metadata: Record<string, unknown>;
}

/**
 * Options for recording a stream merge event.
 */
export interface RecordMergeOptions {
  /** Stream that was merged FROM (source) */
  sourceStreamId: string;
  /** Commit SHA in the source stream that was merged */
  sourceCommit: string;
  /** Stream that was merged INTO (target) */
  targetStreamId: string;
  /** Resulting merge commit SHA in the target */
  mergeCommit: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Stack and Review Block data models and types.
 *
 * A Review Block is a logical reviewable unit (like a PR) containing
 * one or more commits. Stacks are ordered collections of Review Blocks
 * within a stream, intended for incremental review (opt-in feature).
 */

export type ReviewStatus = 'draft' | 'review' | 'approved' | 'merged';

/**
 * A Review Block is a logical reviewable unit containing one or more commits.
 * Similar to a PR, it has a title, description, and review status.
 */
export interface ReviewBlock {
  /** Unique identifier (e.g., "rb-xxxx") */
  id: string;
  /** Parent stream ID */
  streamId: string;
  /** Named stack (default: "default") */
  stackName: string;
  /** Order in stack (0 = bottom/oldest) */
  position: number;
  /** PR-like title */
  title: string;
  /** Optional detailed description */
  description: string | null;
  /** Review status */
  reviewStatus: ReviewStatus;
  /** Reviewer identifier */
  reviewedBy: string | null;
  /** Review timestamp (ms) */
  reviewedAt: number | null;
  /** Commits in this review block */
  commits: StackEntry[];
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Last update timestamp (ms) */
  updatedAt: number;
}

/**
 * A Stack Entry represents an individual commit within a Review Block.
 */
export interface StackEntry {
  /** Unique identifier (e.g., "stack-xxxx") */
  id: string;
  /** Parent review block ID */
  reviewBlockId: string;
  /** Current commit hash (changes on rebase) */
  commitHash: string;
  /** Position within the review block */
  commitPosition: number;
  /** Original commit hash for tracking across rebases (via patch-id) */
  originalCommit: string;
}

/**
 * Stack configuration - extensible JSON config per stream per stack.
 */
export interface StackConfig {
  /** Auto-create review blocks for new commits (default: true) */
  autoPopulate?: boolean;
  /** Grouping strategy for auto-population */
  groupingStrategy?: 'per-commit' | 'manual' | 'auto-smart';
  /** Behavior when rebuilding stack after rebase */
  rebuildBehavior?: {
    /** Strategy for matching old commits to new commits */
    matchStrategy: 'patch-id' | 'change-id' | 'message';
    /** Delete entries for squashed/dropped commits */
    deleteOrphaned: boolean;
  };
  /** Review workflow settings */
  reviewWorkflow?: {
    /** Require approval before merge */
    requireApproval: boolean;
    /** List of allowed reviewers */
    allowedReviewers?: string[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Options Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateReviewBlockOptions {
  /** Parent stream ID */
  streamId: string;
  /** Named stack (default: "default") */
  stackName?: string;
  /** One or more commit hashes */
  commits: string[];
  /** PR-like title */
  title: string;
  /** Optional detailed description */
  description?: string;
}

export interface AddCommitsToBlockOptions {
  /** Review block ID */
  reviewBlockId: string;
  /** Commit hashes to add */
  commits: string[];
}

export interface SetReviewStatusOptions {
  /** Review block ID */
  reviewBlockId: string;
  /** New review status */
  status: ReviewStatus;
  /** Reviewer identifier */
  reviewer?: string;
}

export interface ReorderStackOptions {
  /** Stream ID */
  streamId: string;
  /** Stack name */
  stackName: string;
  /** Review block IDs in desired order */
  newOrder: string[];
  /** Agent performing the reorder */
  agentId: string;
  /** Worktree path for git operations */
  worktree: string;
}

export interface RebuildStackOptions {
  /** Stream ID */
  streamId: string;
  /** Stack name (default: "default") */
  stackName?: string;
}

// Legacy type aliases for backwards compatibility
export interface AddToStackOptions {
  streamId: string;
  commit: string;
  description?: string;
}

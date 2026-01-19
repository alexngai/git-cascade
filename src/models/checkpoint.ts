/**
 * Checkpoint and Diff Stack data models and types.
 *
 * Part of the unified checkpoint/diff stack architecture (s-366r).
 *
 * Checkpoints are raw commit snapshots with minimal state.
 * Diff Stacks are reviewable/mergeable units that group checkpoints.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Review Status (for diff stacks)
// ─────────────────────────────────────────────────────────────────────────────

export type DiffStackReviewStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'merged'
  | 'abandoned';

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Checkpoint represents a snapshot of an individual commit.
 * Minimal state - just git identity and tracking info.
 * Review/queue state lives on DiffStacks, not checkpoints.
 */
export interface Checkpoint {
  /** Unique identifier (e.g., "cp-xxxx") */
  id: string;
  /** Parent stream ID */
  streamId: string;
  /** Current commit SHA */
  commitSha: string;
  /** Parent commit SHA (for context) */
  parentCommit: string | null;
  /** Original commit SHA before any rebases (for tracking) */
  originalCommit: string | null;
  /** Change-Id for logical change tracking across rebases */
  changeId: string | null;
  /** Commit message */
  message: string | null;
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Creator identifier */
  createdBy: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff Stack
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Diff Stack is a reviewable/mergeable unit that groups one or more checkpoints.
 * This is the primary unit for code review and merge queue management.
 *
 * Key features:
 * - Can contain checkpoints from multiple streams (multi-agent consolidation)
 * - Checkpoints can be in multiple stacks (for exploration)
 * - Queue position determines merge order per target branch
 */
export interface DiffStack {
  /** Unique identifier (e.g., "ds-xxxx") */
  id: string;
  /** Optional human-readable name */
  name: string | null;
  /** Optional description */
  description: string | null;
  /** Target branch for merge (default: 'main') */
  targetBranch: string;
  /** Review workflow status */
  reviewStatus: DiffStackReviewStatus;
  /** Reviewer identifier */
  reviewedBy: string | null;
  /** Review timestamp (ms) */
  reviewedAt: number | null;
  /** Review notes/comments */
  reviewNotes: string | null;
  /** Position in merge queue for target_branch (null = not queued) */
  queuePosition: number | null;
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Creator identifier */
  createdBy: string | null;
}

/**
 * Diff Stack with its checkpoint entries included.
 */
export interface DiffStackWithCheckpoints extends DiffStack {
  /** Checkpoints in this stack, ordered by position */
  checkpoints: CheckpointInStack[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff Stack Entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Diff Stack Entry links a checkpoint to a stack with ordering.
 * This is a many-to-many relationship - checkpoints can be in multiple stacks.
 */
export interface DiffStackEntry {
  /** Unique identifier */
  id: string;
  /** Parent stack ID */
  stackId: string;
  /** Checkpoint ID */
  checkpointId: string;
  /** Position within the stack (0-indexed) */
  position: number;
}

/**
 * Checkpoint with its position in a stack (for joined queries).
 */
export interface CheckpointInStack extends Checkpoint {
  /** Position within the stack */
  position: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Options Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateCheckpointOptions {
  /** Parent stream ID */
  streamId: string;
  /** Commit SHA */
  commitSha: string;
  /** Parent commit SHA */
  parentCommit?: string;
  /** Original commit SHA (pre-rebase) */
  originalCommit?: string;
  /** Change-Id for tracking */
  changeId?: string;
  /** Commit message */
  message?: string;
  /** Creator identifier */
  createdBy?: string;
}

export interface CreateDiffStackOptions {
  /** Optional human-readable name */
  name?: string;
  /** Optional description */
  description?: string;
  /** Target branch for merge (default: 'main') */
  targetBranch?: string;
  /** Initial checkpoint IDs to include */
  checkpointIds?: string[];
  /** Creator identifier */
  createdBy?: string;
}

export interface AddCheckpointToStackOptions {
  /** Stack ID */
  stackId: string;
  /** Checkpoint ID */
  checkpointId: string;
  /** Position in stack (appends to end if not specified) */
  position?: number;
}

export interface SetStackReviewStatusOptions {
  /** Stack ID */
  stackId: string;
  /** New review status */
  status: DiffStackReviewStatus;
  /** Reviewer identifier */
  reviewedBy?: string;
  /** Review notes */
  notes?: string;
}

export interface QueueStackOptions {
  /** Stack ID */
  stackId: string;
  /** Position in queue (appends to end if not specified) */
  position?: number;
}

export interface ListCheckpointsOptions {
  /** Filter by stream ID */
  streamId?: string;
  /** Filter by change ID */
  changeId?: string;
  /** Only return checkpoints not in any stack */
  unstackedOnly?: boolean;
}

export interface ListDiffStacksOptions {
  /** Filter by review status */
  reviewStatus?: DiffStackReviewStatus;
  /** Filter by target branch */
  targetBranch?: string;
  /** Only return queued stacks */
  queuedOnly?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived State Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Information about whether a checkpoint has been merged.
 * Derived from the stacks containing it.
 */
export interface CheckpointMergeInfo {
  /** Whether any containing stack is merged */
  merged: boolean;
  /** IDs of merged stacks containing this checkpoint */
  mergedViaStacks: string[];
}

/**
 * Merge status summary for a diff stack.
 * Derived from the checkpoints it contains.
 */
export interface StackMergeStatus {
  /** Total checkpoints in stack */
  totalCheckpoints: number;
  /** Checkpoints already merged via other stacks */
  alreadyMergedCount: number;
  /** Checkpoints pending merge */
  pendingMergeCount: number;
}
